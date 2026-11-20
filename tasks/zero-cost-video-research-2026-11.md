# Zero-cost video creation research — 2026-11-20

## Bottom line

There is no credible way to promise unlimited, always-available, cloud-hosted AI video or image generation at $0 forever. A provider can change a free quota, require an account, queue the job, watermark output, remove a model, or bill a model that was previously free. A free text-model/API key does not make image/video output free. For example, Google's current Gemini API pricing table lists its image-generation models without a Free Tier: <https://ai.google.dev/gemini-api/docs/pricing>.

The dependable no-metered-service-cost route is local creation: Canvas/SVG/CSS/WebAudio/WebGL, screen capture, locally installed open-source editors, and—when suitable hardware already exists—locally run open-weight image/video models. This still consumes the user's hardware, electricity, storage and possibly internet for the initial download; absolute zero cost cannot be promised in that broader sense.

`video-workshop.html` applies this distinction. Its default renderer is deterministic Canvas art, has no provider/API call path, exports PNG scene frames, assembles a local ZIP with the frame pack and project notes, and can record the animated canvas to a browser-supported video container. It also supports local image files as private scene plates. Optional AI/cloud routes are described as non-guaranteed.

## Routes and practical tradeoffs

| Route | What can be made for $0 in service fees | Main limitation / correct expectation |
| --- | --- | --- |
| Browser-native Canvas/SVG/CSS | Kinetic typography, product explainer graphics, diagrams, chart animation, stylized illustrations, visualizers, interactive web experiences and recorded motion graphics. `canvas.captureStream()` feeds `MediaRecorder`; WebCodecs is an optional low-level path. | Procedural geometry is not photoreal AI. Browser codecs/containers vary; WebCodecs does not itself mux a finished MP4/WebM file. |
| Local still-image frames | Procedural local art, imported user-created/owned images, or output from an open-weight image model installed on hardware the user already owns. Add pan/zoom, masks, parallax, text and dissolves in the local studio/editor. | Locally hosted AI removes a per-request invoice but needs model storage, installation, compute, compatible hardware and power. Check each model/checkpoint license. |
| Local open-weight video models | Current families include Wan 2.2, LTX-2.5, HunyuanVideo-1.5, and CogVideoX; inference can avoid a per-clip cloud bill when run locally. | Open weights are not zero-compute. Wan 2.2 TI2V-5B is listed for 720p/24 fps and consumer RTX 4090-class hardware; an A14B T2V sample recommends at least 80 GB VRAM. LTX-2.5's official 121-frame quick start downloads about 66 GiB of files. CogVideoX documents a 2B version for GTX 1080 Ti and 5B for RTX 3060 (different licenses). HunyuanVideo 1.5 is 8.3B parameters; its official project reports a 480p step-distilled image-to-video run within 75 seconds on an RTX 4090. The older 13B baseline needs 45 GB at 544×960/129f and 60 GB at 720×1280/129f. Check exact current checkpoints and terms: <https://github.com/Wan-Video/Wan2.2>, <https://github.com/Lightricks/LTX-2>, <https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5>, <https://github.com/Tencent-Hunyuan/HunyuanVideo>, <https://github.com/zai-org/CogVideo>. |
| Local open-source production tools | OBS for recording/compositing; Shotcut and Kdenlive for timelines/effects/keyframes/titles; Blender for 3D/VFX plus its video sequence editor. | No subscription does not mean no learning, render time, hardware, storage or power costs. |
| Browser-local AI still demo | MLC Web Stable Diffusion demonstrates client-side WebGPU image generation without a generation server. | Its own research page calls compatibility experimental, reports about 7 GB memory use and narrow Apple-silicon/Chrome Canary testing. It is a technical proof-of-concept, not the always-works fallback: <https://websd.mlc.ai/>. |
| Hugging Face ZeroGPU | Public model Spaces can be tried without a per-generation payment within the free quota. | Official docs list 5 GPU minutes/day for free accounts and 2 minutes/day unauthenticated; quota resets 24 hours after first GPU use. Queue priority, Space uptime and output depend on the demo: <https://huggingface.co/docs/hub/en/spaces-zerogpu>. |
| Colab notebooks | Interactive experiments with open-weight image/video notebooks can use free compute when available. | Google says free GPU availability is not guaranteed and limits fluctuate; its free managed runtimes prohibit bypassing the notebook UI to serve a web UI for content generation. Not a reliable app/backend: <https://research.google.com/colaboratory/faq.html>. |
| Kaggle notebooks | Interactive experiments with open models on free GPU sessions. | Kaggle documents a weekly GPU quota of 30 hours or sometimes higher depending on demand/resources; accelerators and session time are limited: <https://www.kaggle.com/docs/efficient-gpu-usage>. |
| PixVerse Basic | A current $0 web plan lists 60 initial and 30 daily credits and up to 540p output. | This is an account-based, credit-capped web service, not an always-on free API; model costs, queue, watermark and terms can change. Provider plan page: <https://app.pixverse.ai/subscribe>. |

### Image generation and frame consistency

- **Always-available procedural route:** use deterministic seeded Canvas/SVG scenes. These make actual raster PNG frames at the chosen ratio, with local color, layers, shapes and captions; no diffusion model or external call is involved.
- **AI stills with no per-call cloud fee:** download/use an open-weight image model on an existing local computer. The official SDXL Base card describes a standalone 3B-parameter text-to-image model under CreativeML Open RAIL++-M; its license and limitations (including unreliable generated text) govern use: <https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0>. A local UI such as ComfyUI is one option: <https://github.com/comfyanonymous/ComfyUI>.
- **Experimental browser route:** Web Stable Diffusion proves that a diffusion model can run in a browser, but the MLC project page warns that it may not work in the user's environment. Do not make a production promise around this demo.
- **Hosted API route:** never infer image/video pricing from text-model pricing. Check the model-specific official pricing page before using a key. Do not put a paid provider key into an app described as guaranteed $0.
- **Continuity recipe:** draft 4–8 shots, generate one still per shot (not a new AI image for every video frame), reuse the same subject/style/lighting/lens language and seed/reference where supported, retain safe caption areas, and animate each still with a restrained pan/zoom, 2.5D parallax, or short crossfade.

## Production workflow and suggested specs

1. Draft a concise brief and 4–8 scene beats, each with one subject and one visible action.
2. Choose a consistent aspect and palette. Use 1920×1080 landscape, 1080×1920 vertical, or 1080×1080 square for final stills when local memory allows; use 1280×720 previews on slower devices.
3. Generate one clean PNG still per shot procedurally or from an appropriately licensed local image model. Do not rely on generated text inside an image; render titles and captions as a separate layer.
4. Add 3–6 seconds per scene, a gentle camera move, and a short dissolve or hard cut. Keep subject identity, light direction, visual scale, screen direction and palette consistent.
5. Record Canvas at about 30 fps with a supported `MediaRecorder` MIME type, or import PNGs into a local editor for precise timing, captions, audio, color and MP4 export. Keep PNGs as a lossless fallback.
6. Open-source local finalizers: Shotcut (<https://www.shotcut.org/>), Kdenlive (<https://kdenlive.org/>) or Blender (<https://www.blender.org/features/video-editing/>). Blender's official license page says the software can run without internet: <https://www.blender.org/about/license/>. OBS is a local capture/compositing option: <https://obsproject.com/>.

## Primary technical references

- Canvas `captureStream()`: <https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream>
- `MediaRecorder` and MIME capability checks: <https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder>
- WebCodecs frame-level encode/decode: <https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API>
- p5.js creative coding library (free/open source): <https://p5js.org/>

**Checked:** November 20, 2026. Quotas, model availability, versions and licenses can change; the linked provider/model pages are authoritative over this snapshot.
