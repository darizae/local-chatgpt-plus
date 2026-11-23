# Linux VPS visual verification through Local ChatGPT Plus (design proposal)

**Status:** Investigation and implementation design only; not deployed or tested end-to-end.  
**Scope:** Headless Linux-hosted LCP, screenshots and equivalent observations, model-visible MCP output, UI verification, and optional isolated native GUI sessions.  
**Date:** 2026-11-23.  
**Privacy:** This public document intentionally contains no account identifiers, user paths, hostnames, IP addresses, credentials, private URLs, or deployment-specific configuration.

## Executive decision

Build **headless browser verification first** using pinned Playwright/Chromium running inside an isolated, resource-bounded Linux execution context. Return a **real MCP image content block** plus concise, structured metadata, and offer an **accessibility/DOM snapshot** and deterministic assertions alongside the screenshot. Keep the existing `view_image` tool for already-generated images. Do **not** install a desktop environment merely to capture web UI screenshots.

Add **native Linux GUI capture** as a separate, opt-in second tier (private Xvfb session first for X11-compatible apps; headless Wayland/compositor or open-source computer-use MCP only after compatibility and security evaluation). Prefer a **native LCP safety wrapper** over unfiltered direct upstream browser/desktop tools.

A screenshot is evidence, not an autonomous verdict. Visual models can interpret it; Playwright assertions, accessibility checks, logs, and image comparisons provide repeatable checks. Both should feed a verification summary with uncertainty and provenance.

## What the repository already provides (source-level findings)

- `src/tools/image.ts` registers `view_image`. It validates a local path, accepts PNG/JPEG/WebP/GIF and returns a real MCP `content: [{type: "image", data: <base64>, mimeType: ...}]` block together with a standard text/structured envelope. Raw input is capped at **5 MiB**.
- `src/lib/tool-profile.ts` includes `view_image` in the **slim** tool profile, so a new tool is not required solely to transmit an existing PNG to an MCP client.
- `src/server-factory.ts` limits serialized tool results to roughly **7 MiB**, below the documented secure tunnel's **10 MiB** message ceiling. Any new visual tool must measure the **entire** serialized MCP result after base64 encoding and metadata; the 5 MiB raw limit is not itself a proof of safe serialized size.
- `src/lib/mcp-tool-proxy.ts` deliberately treats directly proxied third-party MCP tools as potentially mutating, regardless of an upstream `readOnlyHint`, and requires local write/unsafe-runtime permission. That is sensible for unknown upstreams but unsuitable as the *only* path for seamless, scoped screenshot capture.
- `src/tools/computer-use.ts` is primarily a macOS browser/desktop integration and includes an explicit local OMP relay path. It is **not** evidence that a headless Linux VPS currently has a browser, display server, or capture workflow.
- `src/lib/permissions.ts` uses application-level profiles. Workspace roots and a Git worktree do **not** provide OS-level isolation for a Chromium process. Follow the existing project security policy.
- The connected VPS endpoint exposed the source and reported a live LCP runtime, but its connector permissions allowed **file reads only** during this investigation. Installed browser packages, GPU/display variables, and actual ChatGPT rendering of a new screenshot were **not** established. Do not mark Linux visual capture as implemented.

### Verify the complete path

The required demonstration is **real rendered pixels** from a synthetic local test page, captured by a headless browser on Linux, returned as an MCP image block by the VPS LCP connector, and **visibly inspectable by the ChatGPT model**. A saved file path, a base64 text blob, a GitHub artifact link, or a successful LCP unit test alone does *not* demonstrate the model has seen the image.

```text
Local test/preview web app (explicit allowed origin)
     -> isolated headless Chromium + Playwright
     -> screenshot + accessibility tree + console/assertions
     -> size/format bounds and secret-sensitive capture policy
     -> LCP native tool: structured summary + MCP ImageContent
     -> existing authenticated LCP MCP endpoint / HTTPS ingress
     -> ChatGPT connector
     -> image is actually presented to the model for visual inspection
```

For an existing image (e.g., an artifact from a build/test), the minimal path is `build/test -> local PNG -> view_image -> ChatGPT`. Prove this simpler path before introducing any new desktop software.

## Candidate open-source technologies

| Option | Role | Benefits | Limitations / decision |
|---|---|---|---|
| [Microsoft Playwright](https://playwright.dev/docs/screenshots) + headless Chromium | **Recommended P0** for web UIs | No X11/Wayland required, full-page/element screenshots, deterministic viewport, DOM/accessibility/testing APIs; JavaScript/TypeScript fits LCP | Browser binary/dependencies and sandboxing needed; screenshots may contain sensitive data |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | **P0 prototype/reference** for MCP-ready browser tools | Existing `browser_snapshot`, `browser_take_screenshot`, optional vision capabilities and headless configuration | Upstream proxy currently has conservative permission semantics; broad browser-control tool catalog can expand attack surface; wrap or allowlist |
| [Playwright Test visual comparisons](https://playwright.dev/docs/test-snapshots) and [ARIA snapshots](https://playwright.dev/docs/aria-snapshots) | **P0** deterministic verification | Screenshot baseline diffs, stable semantic accessibility assertions, useful machine-verifiable pass/fail | Golden-image maintenance; cross-platform/font/rendering differences require consistent environment |
| [Puppeteer / Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing) | P1 alternative for browser capture | Mature Chromium-focused headless screenshots and CDP automation | Duplicates Playwright; prefer one default browser stack |
| [Xvfb](https://www.x.org/docs/man/man.pdf) + X11 capture utilities such as `scrot` | **P2**, legacy/native X11 GUI | Simple software virtual display, useful for desktop apps in unattended CI | Requires launching apps inside a dedicated virtual display; no Wayland-first semantics |
| [waymux](https://github.com/waymux/waymux) | **P2 exploratory** headless Wayland sessions | Private virtual desktop, screenshot/record/control and MCP server; no physical monitor/GPU required in documented CPU mode | Early public-release project; audit maturity, dependencies, resource use, and permissions first |
| [OpenComputerUse](https://github.com/IAmJSD/OpenComputerUse) | P2 exploratory isolated GUI computer use | Linux sessions with private Xvfb or software Wayland, screenshots and accessibility support | Much broader action capability than screenshot-only; require strict capability gating and review |
| [kde-mcp](https://github.com/atassis/kde-mcp) | P3 for a KDE-specific deployment | AT-SPI accessibility-first model; virtual KWin mode; screenshots as fallback | Not a general solution for minimal headless server; KDE/Plasma dependencies |
| [Wayland MCP](https://github.com/alex-oleshkevich/wayland-mcp) / [screenshooter-mcp](https://github.com/emmanuel-deloget/screenshooter-mcp) | P3 candidate survey | Existing Linux screenshot-oriented MCP implementations | Need supported compositor/session and third-party code review; not interchangeable with headless browser capture |
| [Ollama vision-capable models](https://ollama.com/library/qwen3-vl) | **Optional**, local image interpretation | Can evaluate screenshot locally when sufficient CPU/RAM/GPU available | Does not *capture* a screen; can hallucinate; resource/performance and privacy validation required |

**Pragmatic selection:** Playwright is the primary backend. Playwright MCP is the fastest way to validate the capture workflow in a disposable environment, while a **small native LCP tool** is the preferred production interface. Evaluate waymux/OpenComputerUse only if native Linux GUI inspection is a real requirement. Do not install every candidate.

## Proposed capabilities and API

### P0 — `visual_capture_web` (native LCP read/observation entry point)

Register one bounded tool in a proposed `src/tools/visual.ts` module, imported by `src/server-factory.ts`, included in `src/lib/tool-profile.ts`, and tested by the tool-catalog synchronization test.

Suggested validated input (interface proposal, **not** an implemented schema):

```ts
type VisualCaptureWebInput = {
  url: string; // explicit allowlisted origin; no arbitrary internal-network fetch
  viewport?: { width: number; height: number }; // bounded defaults
  full_page?: boolean;
  format?: "png" | "jpeg" | "webp";
  clip?: { x: number; y: number; width: number; height: number };
  include_accessibility?: boolean; // true by default
  include_console_errors?: boolean; // true by default
  test_marker?: string; // optional, public fixture identifier, not a secret
};
```

Output:
- `content`: brief text with capture ID, viewport, timestamp, origin class, status and checks **plus one real ImageContent block** (`data` base64 + `mimeType`). Never substitute merely a file path for the image.
- `structuredContent`: normal `{ok, tool, summary, data}` envelope with width/height, MIME type, raw and serialized byte counts, capture ID, accessibility summary, console/page errors, checks and sanitization flags. **No base64 duplication** in structured content or text.
- If screenshot exceeds transport budget, downscale/re-encode **with explicit original/final dimensions and quality metadata**, or return a useful bounded error. Never silently truncate image bytes.
- Keep optional internal capture artifact in a restrictive ephemeral directory outside the repository, with a short retention policy. Do not return an externally accessible image URL unless independently authenticated.

A screenshot is normally an observation, but browser navigation and page JavaScript can have side effects. Treat this as a scoped, network-capable observation and grant read-like convenience **only within a separately isolated capture browser**, without shell capability or persisted auth sessions. User-authorized browsing outside explicit preview origins should require a distinct capability and policy decision.

### P0 — `visual_verify_web` (deterministic evidence)

This can start as ordinary Playwright tests instead of an MCP tool. For a user-requested verification, collect:
1. Screenshot: desktop and optionally mobile viewport.
2. DOM/accessibility snapshot: headings, labels, role/name and expected visible text.
3. Playwright assertions: expected controls visible, dimensions/responsive layout, no uncaught page errors, no failed targeted requests.
4. Optional screenshot comparison against a baseline with stable font/browser/OS versions and tolerance rules.
5. Human/model visual interpretation of the image, marked as **judgment** rather than deterministic pass/fail.

Return an evidence record with **observed**, **asserted**, **interpreted**, **not checked**, and **blocked** states. Do not report “visually verified” if the screenshot was merely saved or if the client did not ingest an image.

### P1 — reuse `view_image` and artifact outputs

Enhance only if tests demonstrate a need: safe MIME sniffing versus extension, strict file-size bounds, no arbitrary path exposure beyond existing permission policy, image downscaling for oversize files and optional selection by opaque capture ID. Avoid changing `view_image`'s existing success contract without regression coverage.

Use the existing image tool for:
- Build-generated screenshots, chart previews, SVG rendered to PNG, image diff output and locally generated render artifacts.
- Headless Playwright screenshots that were captured by a separate trusted worker.
- A synthetic fixture to prove the model receives MCP image content.

### P2 — optional `visual_capture_desktop` for native applications

Explicit opt-in only. Provision an **ephemeral GUI session** under an unprivileged, dedicated OS identity. First evaluate `Xvfb` + `scrot` for X11-compatible fixtures; evaluate waymux/headless Wayland for native Wayland apps or richer UI control. Provide:
- Session start/end with bounded lifetime and isolated `DISPLAY`/`WAYLAND_DISPLAY` ownership.
- Screenshot of the **session/window**, not the actual host desktop.
- Strict separation between `observe` and `act` (click/type/launch); actions require independent policies and review.
- The same image-return contract and privacy/retention policy as browser capture.
- No globally accessible VNC/CDP/Wayland sockets. Any optional viewer binds loopback, is authenticated, and is never exposed via the public MCP endpoint.

## Linux preflight and packaging (to be run in an authorized VPS maintenance window)

The investigation was read-only; **none of the following commands was run** on the live VPS:

```sh
# Metadata-only inventory, without printing environment values or credentials:
uname -s
grep '^PRETTY_NAME=' /etc/os-release
for binary in chromium chromium-browser google-chrome firefox Xvfb xvfb-run weston scrot grim; do
  command -v "$binary" >/dev/null && printf '%s available\n' "$binary"
done
for variable in DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE; do
  env | cut -d= -f1 | grep -qx "$variable" && printf '%s present\n' "$variable"
done
```

Preflight must also record generic CPU architecture, available RAM, disk space and ability to run a **non-root sandboxed Chromium**; do **not** print private hostnames, IPs, home paths, token values or current browser tabs in public logs.

Install a **version-pinned**, lockfile-controlled Playwright package and matching browser in a test container/worker, not as an arbitrary `npx @latest` command invoked on demand. Record OS-level font libraries, timeout/memory limits and Chromium sandbox availability. Never use `--no-sandbox` as an unreviewed workaround. Pin the base container image and use CI dependency/security scanning.

Suggested starter setup: a private/isolated preview server bound to an explicitly allowed loopback port, and a headless Chromium capture worker with fixed locale, timezone, viewport and fonts for reproducible screenshots. The browser worker must not inherit LCP OAuth, upstream MCP tokens or host secrets.

## Security and confidentiality requirements

This feature must coexist with the prompt-injection and encrypted-transport security roadmap.

1. **Network SSRF:** The capture worker is not a generic arbitrary-URL fetch tool. Default to explicitly configured preview origins/ports; forbid `file:`, `data:`, `javascript:` and internal metadata/control endpoints. Validate DNS answers **and redirects**, account for IPv4/IPv6 and DNS rebinding, and enforce egress isolation at OS/container network policy level. Playwright MCP documents that its origin lists alone are not a security boundary.
2. **Browser compromise:** Use a dedicated low-privilege OS/container identity, Chromium sandbox and resource controls; restrict mounts, inherited environment, downloadable files, service-account tokens and network. Never expose CDP debugging ports outside a private namespace.
3. **Capture confidentiality:** Screenshots can contain passwords, cookies, OAuth codes, internal URLs and personal information. Prefer sanitized synthetic fixtures. Mask configured sensitive elements before capturing where practical; explicitly mark masking as **best effort**, not foolproof. Never publish full screenshots or pixel artifacts into public Git, PR comments, CI artifacts, logs or shared object storage by default.
4. **Permission policy:** Only authenticated LCP callers with allowed tool scopes may request capture. Keep read-only capture separate from browser actions. No automatic fallback from a denied URL to unrestricted shell/desktop capture. Browser execution is not equivalent to a filesystem read and must be isolated.
5. **Prompt injection:** On-screen text, DOM/accessibility strings, web page content and image OCR are all *untrusted* material. Never treat their instructions as new authorization or tool policy. The security policy must govern actions independently of the model's screenshot interpretation.
6. **Transport:** Continue using authenticated TLS-protected MCP ingress; binary images travel inside MCP response bodies. Do not create a public screenshot HTTP server or external unauthenticated artifact URLs.
7. **Limits:** Conservative pixel dimensions (e.g., default 1280×720; explicit bounded maximum), capture duration, page count, concurrency, browser memory, screenshot raw bytes, complete serialized MCP size and ephemeral artifact retention. Bounded quality/dimension reduction must be observable to the client.
8. **Audit:** Log only generic operation category, anonymized capture identifier, dimensions, outcome, permitted-origin category, elapsed time and sanitized error class. Avoid raw request URLs if they can contain sensitive query parameters.

## Seamless authenticated use and backwards compatibility

- **Default UX:** Once an authorized operator has enabled a scoped preview capability, capture of that project's allowlisted test UI should proceed without per-shot confirmation, while still honoring independent MCP/tool authorization.
- **Separation:** Screenshots, accessibility tree reads and benign assertions remain available under a restricted capture permission profile; keyboard, mouse, arbitrary web navigation, filesystem access and external exfiltration remain separately gated.
- **No regressions:** No new prompt or browser startup for ordinary `view_image`, file reads, edits, Git and shell tools. The feature should fail predictably when browser dependencies are absent; it must not start a native desktop unrequested.
- **Fallback:** If image transport is rejected by ChatGPT or a tunnel size limit, report exactly what failed and offer bounded re-encoding; *do not* claim verification from a filename.
- **Rollout:** Default OFF for general external URLs and native GUI control. Enable **local test-origin capture** only after isolated tests and an operator-reviewed configuration. Keep the prior behavior for all existing tools.

## Implementation backlog

| Phase | Change | Suggested code/test location | Exit gate |
|---|---|---|---|
| 0 — baseline | Demonstrate `view_image` sending a small, synthetic fixture through the actual VPS-to-ChatGPT connector | Existing `src/tools/image.ts`; dedicated fixture; operator test | ChatGPT actually sees pixels, MIME, size and structured metadata; no personal content |
| 1 — proof of concept | Run pinned Playwright + headless Chromium on isolated Linux and capture a synthetic local page | Disposable container or private worker, not production LCP | Screenshot + accessibility tree + console output produced without display server |
| 2 — native MCP | Add `visual_capture_web`, visibility, policy, transport size checks and tests | `src/tools/visual.ts`, `src/server-factory.ts`, `src/lib/tool-profile.ts`, `scripts/test-linux-visual.mjs` | One tool call returns real `ImageContent`, sane metadata and no duplicate base64 |
| 3 — deterministic verification | Add fixtures for screenshots, DOM/ARIA, visual diffs, console errors and error classification | Test suite + verification routines | Repeatable positive/negative results under pinned fonts/browser |
| 4 — hardening | Origin/redirect/DNS/network isolation, OS sandbox, throttling, masking, retention and audit tests | Visual policy helper + container config + security fixtures | Block malicious URLs/redirects; no host credential exposure |
| 5 — real connector acceptance | Authorize a disposable preview app and capture through hosted ChatGPT/HTTPS MCP | Test/deployment runbook; no personal screenshots | ChatGPT can describe a deliberately planted, unique visual marker and identify mismatches |
| 6 — optional native GUI | Evaluate Xvfb, waymux and/or OpenComputerUse in an isolated environment | Separate `visual_capture_desktop` feature branch | Real app/window screenshot via MCP without accessing host desktop |

Keep these tasks in an isolated Git worktree/branch, compile and run the appropriate source tests, avoid restarting active LCP workers, and defer any production deployment until approved. Changes to tool catalogs require a connector refresh and fresh session. Do not merge new GUI action privileges with read-only screenshot privileges.

## Acceptance and regression suite

Run with **synthetic** content and recorded timings; never use sensitive real screenshots to prove a feature.

**Expected allowed (must all pass without new approval prompts after capability setup):**
1. Headless screenshot of a synthetic local HTML page; returned image can be visually read by the model.
2. 1280×720 and bounded mobile viewport with correct PNG/JPEG/WebP MIME and dimensions.
3. Accessibility snapshot reports test heading, button name and aria-label accurately.
4. A visually wrong but DOM-correct fixture produces a model-visible discrepancy; deterministic assertions report only what they actually checked.
5. `view_image` still returns an existing small image unchanged.
6. A screenshot-over-budget fixture is downscaled with metadata or returns a clear bounded error, never a transport-level hang.
7. Two concurrent captures are isolated and leave no leaked browser processes or private artifacts.
8. A missing browser binary returns a bounded actionable error; unrelated LCP tools continue to work.

**Expected denied/contained (must all pass):**
1. External URL, cloud metadata target, private-network target and file URL rejected without network access.
2. Redirect chain and DNS rebind toward forbidden destinations blocked at worker egress.
3. Requests for arbitrary JS evaluation, CDP attachment or host desktop input cannot be smuggled through `visual_capture_web`.
4. Screenshot attempt containing synthetic canary secrets is masked/denied according to policy; no canaries appear in logs or public artifacts.
5. An HTML page containing prompt-injection text cannot grant tool permissions or cause shell commands.
6. An unauthorized OAuth subject/scope cannot invoke capture; an authorized subject cannot exceed assigned origins.
7. Oversized images, decompression bombs and repeated capture floods remain bounded in CPU, memory, time, and transport bytes.
8. Screenshot/visual interpretation does not claim proof of working login, transaction success or authorization when only pixels are available.

**Performance/UX gates:** Set measurable p50/p95 capture latencies and CPU/RAM limits from actual VPS hardware in the PoC; do not assert invented capacity. Maintain **zero unexpected denials and zero extra confirmations** in the curated authorized benign-flow suite. All security tests must be non-destructive and reproducible.

## Open questions and decisions needed before implementation

- Does the Linux service need **web UI verification only**, or an actual full **native GUI session** (GTK/Qt/KDE)? This changes the second-tier backend, not the Playwright-first default.
- Is the first target a local preview web app, a private staging domain, or a broader public site? Define a **bounded set of allowed origins**.
- Will ChatGPT's hosted model be the vision reviewer, or is an **optional local VLM** required for confidential/offline image interpretation? Benchmark locally before adding this dependency.
- Is the current VPS provisioned with enough memory, browser runtime dependencies and sandbox support? Verify in a permitted maintenance window.
- Does the ChatGPT connector deliver `ImageContent` intact from this VPS? This remains the first practical test.

## References

- MCP specification: [Tool results including image content](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
- Playwright: [screenshots](https://playwright.dev/docs/screenshots), [accessibility snapshots](https://playwright.dev/docs/aria-snapshots), [visual comparisons](https://playwright.dev/docs/test-snapshots).
- Playwright MCP: [repository](https://github.com/microsoft/playwright-mcp), [headless/configuration options](https://playwright.dev/mcp/configuration/options), [screenshot tools](https://playwright.dev/mcp/tools/screenshots).
- Headless browser alternatives: [Chrome for Testing/Headless](https://developer.chrome.com/docs/automation-and-testing).
- Native GUI candidates: [Xvfb reference](https://www.x.org/docs/man/man.pdf), [Weston headless backend](https://wayland.pages.freedesktop.org/weston/toc/running-weston.html), [waymux](https://github.com/waymux/waymux), [OpenComputerUse](https://github.com/IAmJSD/OpenComputerUse), [kde-mcp](https://github.com/atassis/kde-mcp).
- Optional VLM: [Ollama image-capable Qwen3-VL distribution](https://ollama.com/library/qwen3-vl).

**Document status:** A design proposal, not a claim that screenshot capture, new Linux dependencies, visual model analysis, or production encryption have been implemented or verified.
