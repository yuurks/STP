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

const DEFAULT_DURATION_SECONDS = 15; // matches shorts.js's REVEAL_VIDEO_MS -- this is only the fallback path if the animated reveal pipeline fails, but should still be the same length

function run(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}\n${stderr}`));
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

// A real audio file to lay under the reveal video, if one exists -- checked at call time, not
// import time, so dropping a file in later (or swapping it) never needs a restart to take effect.
// YouTube's own Shorts Creator music library (the "saved songs" picker) is a mobile in-app-only
// feature with no API access at all -- there is no way to attach a track from it through the
// upload API this bot uses, for any bot, regardless of how it's built. This is the actual
// alternative: a real audio file, licensed for this use, mixed into the video file itself before
// upload. Overridable via SHORTS_MUSIC_PATH for swapping tracks without a code change.
const DEFAULT_MUSIC_PATH = path.join(__dirname, "..", "..", "assets", "music", "background.mp3");
function resolveMusicPath() {
  const musicPath = process.env.SHORTS_MUSIC_PATH || DEFAULT_MUSIC_PATH;
  return fs.existsSync(musicPath) ? musicPath : null;
}

// Turns shorts.js's buildRevealFrames/generateRevealFramePngs output (an ordered list of real
// rendered PNG frames, each with how long to hold it) into a real animated MP4, via ffmpeg's
// concat demuxer -- each image gets its own on-screen duration rather than a fixed per-frame
// hold, which is what makes fast beats (the percentage count-up, each candle popping in) and slow
// ones (the final CTA hold) both possible from the same mechanism. The last file has to be listed
// a second time with no duration line after it -- a well-known concat-demuxer quirk where the
// final entry's duration is otherwise silently dropped; confirmed necessary, not just caution.
async function generateAnimatedShortVideo(frames) {
  if (!frames.length) throw new Error("generateAnimatedShortVideo needs at least one frame");

  const tmpId = crypto.randomBytes(8).toString("hex");
  const frameDir = path.join(os.tmpdir(), `stp-reveal-${tmpId}`);
  fs.mkdirSync(frameDir, { recursive: true });
  const listPath = path.join(frameDir, "list.txt");
  const outputPath = path.join(os.tmpdir(), `stp-reveal-${tmpId}.mp4`);
  const musicPath = resolveMusicPath();

  try {
    const framePaths = frames.map((frame, i) => {
      const p = path.join(frameDir, `frame-${String(i).padStart(4, "0")}.png`);
      fs.writeFileSync(p, frame.png);
      return p;
    });

    const listLines = [];
    frames.forEach((frame, i) => {
      // ffmpeg's concat demuxer wants forward slashes and single-quoted paths regardless of host OS.
      const safePath = framePaths[i].replace(/\\/g, "/");
      listLines.push(`file '${safePath}'`);
      listLines.push(`duration ${(frame.holdMs / 1000).toFixed(3)}`);
    });
    listLines.push(`file '${framePaths[framePaths.length - 1].replace(/\\/g, "/")}'`);
    fs.writeFileSync(listPath, listLines.join("\n"));

    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath
    ];
    if (musicPath) {
      // -stream_loop -1 repeats the track indefinitely so a short loop still covers the full
      // video regardless of its own length, and -shortest then cuts the OUTPUT to the video's
      // real length (fixed by the image sequence above) rather than the now-infinite audio.
      args.push("-stream_loop", "-1", "-i", musicPath);
    }
    args.push(
      "-map", "0:v",
      "-vf", "format=yuv420p",
      "-r", "30",
      "-vsync", "cfr",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p"
    );
    if (musicPath) {
      args.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k", "-shortest");
    }
    args.push("-movflags", "+faststart", outputPath);

    await run(args, 60000);
    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(frameDir, { recursive: true, force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

module.exports = { generateShortVideo, generateAnimatedShortVideo };
