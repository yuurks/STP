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

const DEFAULT_DURATION_SECONDS = 8;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
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

module.exports = { generateShortVideo };
