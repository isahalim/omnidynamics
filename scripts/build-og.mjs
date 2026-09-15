/**
 * Photographs the landing page into `public/og.jpg` — the card a shared link
 * unfolds into on LinkedIn, Slack, iMessage and X.
 *
 * The card cannot be drawn the way the icons are. The mark is two strokes and
 * `build-icons.mjs` computes it exactly, but the hero is vgpu's glass
 * tetrahedron lit on plaster by a compute pass, and the only thing that knows
 * what that looks like is a GPU running the shaders. So this drives a real
 * browser at the real page and keeps the frame it settles on.
 *
 * It has to be a real browser, on screen. `--headless` has no WebGPU adapter on
 * macOS: the page detects that, says "The prism could not start", and the
 * screenshot is a bare wall with the copy on it — which is exactly the picture
 * this is meant not to ship. A window opens for a few seconds while it works.
 *
 * Chrome does the resizing too, rather than sips or a codec off npm. The frame
 * is taken at twice the card's size and drawn down into a canvas at half, so
 * the glass and the type are supersampled instead of aliased, and the canvas
 * encodes the JPEG on the way out. Nothing here needs a toolchain beyond node
 * and the browser that is already installed.
 *
 *   node scripts/build-og.mjs [url]
 *
 * Defaults to the deployed site, since the card should show what a visitor
 * arriving from the link will actually meet. Pass a dev server to preview a
 * change before it ships. Bump `OG_IMAGE_VERSION` in `src/layouts/Base.astro`
 * afterwards, or the scrapers will go on serving the card they already hold.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 1.91:1, and the size every scraper documents. */
const WIDTH = 1200;
const HEIGHT = 630;
/** Enough to lose the compression's mark on flat plaster, no more. */
const QUALITY = 0.88;

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222;
const url = process.argv[2] ?? "https://omnidynamics.dev/";
const out = fileURLToPath(new URL("../public/og.jpg", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(join(tmpdir(), "og-chrome-"));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT + 80}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

/** The CDP endpoint, once the browser is listening on it. */
const debugger_ = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      // A fresh profile opens on a tab that is not always a debuggable target
      // yet, so ask for one of our own rather than waiting for theirs.
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
        method: "PUT",
      });
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error(`no CDP on :${PORT} — is ${CHROME} there?`);
};

/** A promise-shaped CDP session over the target's socket. */
const connect = async (endpoint) => {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  /** Evaluates in the page and hands back the value, not a remote handle. */
  const evaluate = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result.value;

  return { send, evaluate, close: () => socket.close() };
};

let page;
try {
  page = await connect(await debugger_());
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.send("Page.navigate", { url });

  // `Prism.astro` adds `ready` to the canvas when the renderer's first frame is
  // up, and writes into the status line if it never gets there. Waiting on the
  // class rather than on a delay is what keeps a slow cubemap fetch from being
  // photographed as an empty wall.
  const status = await (async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await page.evaluate(
        `JSON.stringify({
          ready: !!document.querySelector("#prism.ready"),
          status: document.getElementById("prism-status")?.textContent ?? "",
        })`
      );
      const { ready, status } = JSON.parse(state ?? "{}");
      if (status) return status;
      if (ready) return null;
      await sleep(250);
    }
    return "the prism never became ready";
  })();
  if (status) throw new Error(`the page says: ${status}`);

  // The glass drifts and the copy fades up after the first frame. Let both
  // settle, or the card catches the shape mid-move.
  await sleep(2500);

  const { data } = await page.send("Page.captureScreenshot", { format: "png" });

  // Down to size and into a JPEG, in the page, on the GPU that just drew it.
  const card = await page.evaluate(`(async () => {
    const image = new Image();
    image.src = "data:image/png;base64,${data}";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = ${WIDTH};
    canvas.height = ${HEIGHT};
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, ${WIDTH}, ${HEIGHT});
    return canvas.toDataURL("image/jpeg", ${QUALITY});
  })()`);

  const bytes = Buffer.from(card.slice(card.indexOf(",") + 1), "base64");
  writeFileSync(out, bytes);
  console.log(
    `og.jpg  ${WIDTH}x${HEIGHT}  ${(bytes.length / 1024).toFixed(0)} KB  from ${url}`
  );
} finally {
  page?.close();
  chrome.kill();
  // Chrome is still flushing its profile as it goes, and a directory being
  // written to is a directory `rm -r` loses a race with. Wait for the process
  // to be gone, and treat a leftover temp profile as not worth failing over.
  await Promise.race([
    new Promise((resolve) => chrome.once("exit", resolve)),
    sleep(5000),
  ]);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // The OS clears its own temp directory.
  }
}
