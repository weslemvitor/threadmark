// Synthetic inference: Atomics.wait also blocks IPC, like a stuck native call.
const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

process.on("message", (request) => {
  if (request.operation === "load") {
    process.send({ id: request.id, type: "progress", progress: 0.5 });
    if (process.argv[2] === "hang-load") block();
    process.send({ id: request.id, type: "loaded" });
    return;
  }
  if (request.input.localPath.includes("hang")) block();
  if (request.input.localPath.includes("crash")) process.exit(42);
  process.send({
    id: request.id,
    type: "result",
    result: { text: String(process.pid), language: "pt", durationSeconds: 1, needsReview: false },
  });
});
process.once("disconnect", () => process.exit(0));
