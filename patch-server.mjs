import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourcePath = new URL("./server.js", import.meta.url);
const patchedPath = path.join(os.tmpdir(), "signal-render-server-patched.mjs");

const oldBlock = `    const concatPath = path.join(workDir, "scenes.txt");
    const concatLines = [];
    for (const scene of localScenes) {
      concatLines.push(\`file '\${escapeConcatPath(scene.path)}'\`);
      concatLines.push(\`duration \${scene.duration.toFixed(3)}\`);
    }
    concatLines.push(\`file '\${escapeConcatPath(localScenes.at(-1).path)}'\`);
    await fsp.writeFile(concatPath, \`\${concatLines.join("\\n")}\\n\`, "utf8");

    const { width, height } = dimensionsForFormat(payload.format);
    const outputPath = path.join(workDir, "output.mp4");
    const thumbnailPath = path.join(workDir, "thumbnail.jpg");
    const videoFilter = [
      \`scale=\${width}:\${height}:force_original_aspect_ratio=decrease\`,
      \`pad=\${width}:\${height}:(ow-iw)/2:(oh-ih)/2:color=black\`,
      "setsar=1",
      "format=yuv420p",
    ].join(",");

    await updateJob(jobId, {
      progress: 40,
      current_step: "encoding_video",
    });

    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-vf", videoFilter,
      "-r", "30",
      "-c:v", "libx264",
      "-preset", process.env.FFMPEG_PRESET || "veryfast",
      "-crf", process.env.FFMPEG_CRF || "21",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath,
    ]);`;

const newBlock = `    const { width, height } = dimensionsForFormat(payload.format);
    const outputPath = path.join(workDir, "output.mp4");
    const thumbnailPath = path.join(workDir, "thumbnail.jpg");

    await updateJob(jobId, {
      progress: 40,
      current_step: "encoding_video",
    });

    // Normalize every image input before concatenation. The former concat-demuxer
    // path inherited stream parameters from the first image and could collapse
    // mixed-size scene images into a frozen first frame.
    const inputs = [];
    for (const scene of localScenes) {
      inputs.push("-loop", "1", "-t", scene.duration.toFixed(3), "-i", scene.path);
    }

    const normalized = localScenes.map((_, index) =>
      \`[\${index}:v]scale=\${width}:\${height}:force_original_aspect_ratio=increase,\` +
      \`crop=\${width}:\${height},setsar=1,fps=30,format=yuv420p[v\${index}]\`
    );
    const concatInputs = localScenes.map((_, index) => \`[v\${index}]\`).join("");
    const filterComplex = \`\${normalized.join(";")};\${concatInputs}concat=n=\${localScenes.length}:v=1:a=0[v]\`;

    await runFfmpeg([
      "-y",
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[v]",
      "-c:v", "libx264",
      "-preset", process.env.FFMPEG_PRESET || "veryfast",
      "-crf", process.env.FFMPEG_CRF || "21",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath,
    ]);`;

const source = await fs.readFile(sourcePath, "utf8");
if (!source.includes(oldBlock)) {
  throw new Error("Expected video concat block was not found; refusing to start an unpatched renderer.");
}

const patched = source.replace(oldBlock, newBlock);
await fs.writeFile(patchedPath, patched, "utf8");
await import(pathToFileURL(patchedPath).href);
