// Stand-in for `urushi-engine loopback` in tests: prints `PORT <n>`, then
// streams 48 kHz stereo 32-bit float audio (an 880 Hz tone) over that port,
// paced on the wall clock, until the connection closes.
import { createServer } from "node:net";

const rate = 48_000;
const server = createServer((socket) => {
  const started = Date.now();
  let sent = 0;
  const timer = setInterval(() => {
    const target = Math.floor(((Date.now() - started) / 1000) * rate);
    const count = target - sent;
    if (count <= 0) return;
    const buffer = Buffer.alloc(count * 8);
    for (let index = 0; index < count; index++) {
      const value = Math.sin((2 * Math.PI * 880 * (sent + index)) / rate) * 0.5;
      buffer.writeFloatLE(value, index * 8);
      buffer.writeFloatLE(value, index * 8 + 4);
    }
    sent = target;
    socket.write(buffer);
  }, 10);
  socket.on("error", () => undefined);
  socket.on("close", () => {
    clearInterval(timer);
    server.close();
    process.exit(0);
  });
});
server.listen(0, "127.0.0.1", () => {
  console.log(`PORT ${server.address().port}`);
});
