// Turns the static /shorts PNG (see shorts.js) into a real vertical MP4 so it's already in a
// shape YouTube Shorts will accept -- YouTube doesn't take a plain image as a Short upload, it
// needs an actual video file. This is a SEPARATE, additive step: it never touches how the PNG
// itself is generated or how the existing Discord embed/image message gets posted, and every
// caller treats a failure here as "no video this time," not a broken /shorts run -- see
// runShortsDrop in index.js, which posts the image first regardless and only attempts this after.
//
// ffmpeg-static bundles a prebuilt ffmpeg binary matched to whatever platform `npm install` runs
// on (confirmed: resolves to a real, existing binary on both Windows dev and Railway's Linux
// container), so this has no system-level ffmpeg dependency to install separately.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { generateCornerLogoPng, CORNER_LOGO_SIZE } = require("./shorts");

const DEFAULT_DURATION_SECONDS = 15; // matches shorts.js's REVEAL_VIDEO_MS -- this is only the fallback path if the animated reveal pipeline fails, but should still be the same length

// A real Railway run once showed both encoders stalling at single-digit frame counts under
// "-preset ultrafast" (speed=0.258x) with threads already capped at 2 -- the container's available
// CPU, not a code bug. "-preset veryfast" + "-crf 18" is the current tradeoff: noticeably sharper
// output (this content is flat-color UI/text, which compresses cheaply even at low CRF) for only a
// modest step up in encode time from ultrafast -- and if it ever stalls anyway, the animated path
// already falls back to this static-hold encode, and this one still has the 30s default timeout as
// a hard ceiling, so a slow encode degrades gracefully rather than hanging the bot.

function run(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // err.message alone doesn't say WHY the process ended -- err.signal is what actually
        // distinguishes "OOM-killed" (SIGKILL, no ffmpeg error text at all, just silence after the
        // last progress line) from "ffmpeg exited with its own real error" (err.code, usually with
        // explanatory stderr right above it). A real Railway run once died silently mid-encode with
        // no clue why, purely because this was being swallowed.
        reject(new Error(`${err.message} (code=${err.code}, signal=${err.signal})\n${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

// A plain static hold, not a Ken Burns zoom -- the source image is already densely composed
// (headline, card, chart, CTA), so added motion risks looking like a rendering glitch rather than
// intentional style. Silent (no audio track): YouTube accepts video-only Shorts fine, and adding
// a placeholder audio track would only invite an extra thing to get wrong for no real benefit.
async function generateShortVideo(pngBuffer, durationSeconds = DEFAULT_DURATION_SECONDS) {
  const tmpId = crypto.randomBytes(8).toString("hex");
  const inputPath = path.join(os.tmpdir(), `stp-short-${tmpId}.png`);
  const outputPath = path.join(os.tmpdir(), `stp-short-${tmpId}.mp4`);

  fs.writeFileSync(inputPath, pngBuffer);
  try {
    await run([
      "-y",
      "-loop", "1",
      "-i", inputPath,
      "-t", String(durationSeconds),
      "-r", "30",
      "-vf", "format=yuv420p",
      "-c:v", "libx264",
      "-threads", "2",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ]);
    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

// Picks a random real audio file to lay under the reveal video, if any exist -- checked at call
// time, not import time, so dropping files in later (or adding/removing tracks) never needs a
// restart to take effect. YouTube's own Shorts Creator music library (the "saved songs" picker)
// is a mobile in-app-only feature with no API access at all -- there is no way to attach a track
// from it through the upload API this bot uses, for any bot, regardless of how it's built. This
// is the actual alternative: real audio files, licensed for this use, mixed into the video file
// itself before upload. Random rather than fixed/rotating-in-order so repeated /shorts posts in
// the same short window don't all sound identical purely by coincidence of upload order.
const MUSIC_DIR = path.join(__dirname, "..", "..", "assets", "music");
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".aac", ".ogg"]);

function resolveMusicPath() {
  // SHORTS_MUSIC_PATH still wins outright if set -- an explicit single-file override, for anyone
  // who wants exactly one fixed track rather than the pool.
  if (process.env.SHORTS_MUSIC_PATH) {
    return fs.existsSync(process.env.SHORTS_MUSIC_PATH) ? process.env.SHORTS_MUSIC_PATH : null;
  }
  let files;
  try {
    files = fs.readdirSync(MUSIC_DIR).filter(f => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  } catch {
    return null; // assets/music/ doesn't exist yet -- no tracks provided, stays silent
  }
  if (!files.length) return null;
  const pick = files[Math.floor(Math.random() * files.length)];
  return path.join(MUSIC_DIR, pick);
}

// Where shorts.js's highlightSvg draws the corner logo's rotation pivot -- kept in exact sync
// with those constants (W=1080, rightLogoX = W-70-112, rightLogoY = 70) since this overlay has to
// land on the same spot the SVG used to draw it in-place.
const CARD_WIDTH = 1080;
const LOGO_X = CARD_WIDTH - 70 - CORNER_LOGO_SIZE, LOGO_Y = 70;
const LOGO_CENTER_X = LOGO_X + CORNER_LOGO_SIZE / 2, LOGO_CENTER_Y = LOGO_Y + CORNER_LOGO_SIZE / 2;
// A square rotated about its center needs a canvas this big (its own diagonal) to show every
// corner at every angle without clipping -- ffmpeg's rotate filter fills the rest with fillcolor
// (here "none", i.e. transparent) rather than cropping.
const ROTATED_CANVAS = Math.ceil(CORNER_LOGO_SIZE * Math.SQRT2);
const OVERLAY_X = Math.round(LOGO_CENTER_X - ROTATED_CANVAS / 2);
const OVERLAY_Y = Math.round(LOGO_CENTER_Y - ROTATED_CANVAS / 2);
const LOGO_ROTATION_PERIOD_SEC = 3; // one full 360deg spin every 3s -- matches the old per-frame rotation's rate

// Turns shorts.js's buildRevealFrames/generateRevealFramePngs output (an ordered list of real
// rendered PNG frames, each with how long to hold it) into a real animated MP4, via ffmpeg's
// concat demuxer -- each image gets its own on-screen duration rather than a fixed per-frame
// hold, which is what makes fast beats (the percentage count-up, each candle popping in) and slow
// ones (the final CTA hold) both possible from the same mechanism. The last file has to be listed
// a second time with no duration line after it -- a well-known concat-demuxer quirk where the
// final entry's duration is otherwise silently dropped; confirmed necessary, not just caution.
//
// The corner logo is NOT part of any content frame above (see shorts.js's showCornerLogo) --
// instead it's composited here as its own input, spun continuously by ffmpeg's rotate filter
// (angle driven by real elapsed time `t`, not a value we pre-computed per frame) and layered on
// via overlay. That's what makes the rotation genuinely smooth rather than a series of jump cuts
// to a new angle every N milliseconds, which is all a per-frame approach could ever produce no
// matter how many frames it spent on it.
async function generateAnimatedShortVideo(frames) {
  if (!frames.length) throw new Error("generateAnimatedShortVideo needs at least one frame");

  const tmpId = crypto.randomBytes(8).toString("hex");
  const frameDir = path.join(os.tmpdir(), `stp-reveal-${tmpId}`);
  fs.mkdirSync(frameDir, { recursive: true });
  const listPath = path.join(frameDir, "list.txt");
  const logoPath = path.join(frameDir, "corner-logo.png");
  const outputPath = path.join(os.tmpdir(), `stp-reveal-${tmpId}.mp4`);
  const musicPath = resolveMusicPath();

  try {
    const framePaths = frames.map((frame, i) => {
      const p = path.join(frameDir, `frame-${String(i).padStart(4, "0")}.png`);
      fs.writeFileSync(p, frame.png);
      return p;
    });
    fs.writeFileSync(logoPath, await generateCornerLogoPng());

    const listLines = [];
    frames.forEach((frame, i) => {
      // ffmpeg's concat demuxer wants forward slashes and single-quoted paths regardless of host OS.
      const safePath = framePaths[i].replace(/\\/g, "/");
      listLines.push(`file '${safePath}'`);
      listLines.push(`duration ${(frame.holdMs / 1000).toFixed(3)}`);
    });
    listLines.push(`file '${framePaths[framePaths.length - 1].replace(/\\/g, "/")}'`);
    fs.writeFileSync(listPath, listLines.join("\n"));

    // Total on-screen duration, computed directly from the frame holds rather than left to ffmpeg
    // to infer -- confirmed by a real local run that "-shortest" alone does NOT reliably bound
    // this once the logo overlay (an infinite "-loop 1" input) is in the filter graph: the encode
    // just kept going past 15 real MINUTES of output before the exec timeout killed it, instead of
    // stopping at the content video's true ~15s length. An explicit "-t" on the output is a hard,
    // unambiguous cap that doesn't depend on how overlay/filter_complex propagates EOF between a
    // finite main input and an infinite secondary one.
    const totalDurationSec = frames.reduce((sum, f) => sum + f.holdMs, 0) / 1000;

    // Input order: 0 = content frames (finite duration, sets the real video length), 1 = music
    // (only if present; -stream_loop -1 makes it infinite), last = the looped logo still (also
    // infinite -- "-loop 1" repeats a single image forever).
    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath
    ];
    let audioInputIndex = null;
    if (musicPath) {
      args.push("-stream_loop", "-1", "-i", musicPath);
      audioInputIndex = 1;
    }
    const logoInputIndex = musicPath ? 2 : 1;
    args.push("-loop", "1", "-i", logoPath);

    // [0:v]fps=30 first, BEFORE overlay: a real local run showed that feeding the concat stream's
    // irregular per-frame durations (some as short as ~20ms, the final hold ~9s) straight into
    // overlay against the logo's own steady clock made overlay's frame-sync stop early -- it
    // simply never advanced far enough to reach the long final hold, truncating a 15s video to
    // ~5.7s. Converting the main stream to genuine constant-frame-rate first (duplicating the long
    // hold into real repeated frames, exactly what "fps" is for) fixed it outright -- confirmed by
    // re-running the same list.txt both ways and diffing the output duration.
    // format=yuv420p on [0:v] BEFORE fps/overlay, not after: our source PNGs decode as RGBA (4
    // bytes/pixel), and leaving that alone through both fps's rate-conversion (which has to hold/
    // duplicate whole 1080x1920 frames) and overlay's compositing nearly triples the per-frame
    // memory those stages juggle vs converting to yuv420p (~1.5 bytes/pixel) right after decode,
    // same as the old pre-overlay pipeline did. Only the small rotating logo layer actually needs
    // alpha (for its rounded corners' transparency); the background layer never did.
    const filterComplex =
      `[0:v]format=yuv420p,fps=30[mainv];` +
      `[${logoInputIndex}:v]format=rgba,rotate=a='2*PI*t/${LOGO_ROTATION_PERIOD_SEC}':fillcolor=none:ow=${ROTATED_CANVAS}:oh=${ROTATED_CANVAS}[rotlogo];` +
      `[mainv][rotlogo]overlay=${OVERLAY_X}:${OVERLAY_Y}:format=auto,format=yuv420p[vout]`;

    args.push("-filter_complex", filterComplex, "-map", "[vout]");
    if (musicPath) args.push("-map", `${audioInputIndex}:a`);
    // "-preset ultrafast" + explicit "-bf 0 -rc-lookahead 0", not "veryfast": a real Railway run
    // confirmed a SIGKILL (err.signal, not a code/timeout -- a genuine OOM kill) on this exact
    // filter graph under "veryfast", which unlike "ultrafast" enables B-frames + multi-frame
    // lookahead by default (visible in ffmpeg's own log as bframes=3, rc_lookahead=10) -- each of
    // those needs several full 1080x1920 frames held in memory at once for reordering, on top of
    // this filter graph's own overlay/rotate buffering. "ultrafast" (with bf/lookahead forced off
    // regardless) is the configuration that reliably worked before today's changes. crf 18 is kept
    // -- it affects bitrate/quality decisions, not the encoder's frame-buffer memory footprint.
    args.push(
      "-c:v", "libx264",
      "-threads", "2",
      "-preset", "ultrafast",
      "-bf", "0",
      "-rc-lookahead", "0",
      "-crf", "18",
      "-pix_fmt", "yuv420p"
    );
    if (musicPath) args.push("-c:a", "aac", "-b:a", "128k");
    args.push("-t", totalDurationSec.toFixed(3), "-shortest", "-movflags", "+faststart", outputPath);

    // 60s wasn't enough headroom on Railway's actual hardware -- a real run there showed ffmpeg
    // genuinely encoding (climbing frame count, real bitrate), not stuck, just slower than on a
    // dev machine once more frames and music mixing are added on a 2-thread cap. 3 minutes gives
    // real margin without masking an actual hang (which still shows up as the same
    // fallback-to-static-hold behavior, just after waiting longer first).
    await run(args, 180000);
    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(frameDir, { recursive: true, force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

module.exports = { generateShortVideo, generateAnimatedShortVideo };
