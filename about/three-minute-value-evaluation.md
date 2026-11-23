# Three-minute value: adversarial review and evaluation plan

Review date: 2026-11-23. Scope: Social Motion Studio (`motion.html`,
`assets/motion-studio.js`), X Studio (`x-studio.html`, `assets/x-studio.js`),
their dashboard links, and their automated tests. This is a code and copy review,
not a measured usability study or a live verification of X, provider APIs,
quotas, media codecs, accessibility, or browser performance. Examples below are
risks or hypotheses, not observed user hit rates. The accompanying changes fix a
few concrete issues; the remaining recommendations are deliberately not described
as shipped.

## Start with the outcome, not the model

**Three-minute value** means that within 180 seconds from opening the tool, a
user with a real idea can produce a truthful, personally useful, editable asset
that they can reliably save or export and know how to use next. Publishing is
optional and requires explicit user control. For a pre-existing brief, a useful
result might be a draft post or a short video made from the user's own lines;
a polished campaign, a verified claim, or audience growth cannot be promised in
three minutes. No-key/offline and assisted/BYOK routes should be measured
separately. Value is not synonymous with impressions, a high heuristic score,
or a download that the user cannot open.

### Evaluation candidates and what to change

| Candidate from the supplied notes | Use here | Adversarial improvement |
| --- | --- | --- |
| VBench, EvalCrafter, optical flow, physics and identity consistency | Optional for future generative footage or image-to-video | Current Motion Studio animates Canvas text and stills; it is not a 3D camera or diffusion-video model. Optical-flow smoothness cannot prove a 3D camera move. Prioritize actual exported playback, legibility, clipping, timing, and user-supplied image rights instead. |
| Lip sync / phoneme alignment | Not applicable to the present silent Canvas export | Mark N/A, not a zero or a pass. Evaluate sync only if narration/audio is actually added. |
| Platform limits, readability, clichés | Useful advisory checks | X uses platform-specific weighted counting, including links and emoji; the current code-point counter is approximate. Readability, hashtags and fold positions are context-dependent, not universal hard rules. Never treat a regex as factual verification. |
| LLM/VLM judge for hook, tone, value, CTA | Useful for triage and comparative review, with consent | Give judges the brief, target audience, source material, output and rubric, but blind product/version. Require evidence for ratings and an `unknown` option. Treat unsupported claims, invented testimonials and misattributed quotes as hard failures, not issues compensated by a catchy hook. Avoid generic engagement-bait as a default goal. |
| First-pass acceptance, edit distance, cross-modal coherence | Core operational signals | Define acceptance as a user confirming an asset is usable for their goal, not simply clicking export. Separate no edits, minor edits, and major rewrite; raw edit distance punishes useful personalization and can be gamed. Check the first visible video frame and opening post against the same user-supplied premise; do not require matching modalities when only one exists. |

### Hard gates before scoring

1. **Integrity:** no invented statistics, personal experiences, promises, sources,
   quotes or fabricated charts presented as fact. A judge flags potential issues;
   a human verifies against supplied evidence. Missing evidence = unverified,
   not automatically false or true.
2. **Control and durability:** no unconsented publication, silent truncation,
   false success after a failed save, or irreversible loss of the only draft.
3. **Deliverability:** exported file opens in the tested browser/player, has
   nonzero content, and accurately reports format, audio and manual next steps.
4. **Usability:** essential path is keyboard-operable, readable, and exposes
   actionable errors. Confirm contrast, zoom and reduced-motion behavior in real
   browsers; DOM presence alone does not establish accessibility.
5. **Privacy:** keys and source content are sent only to the explicitly chosen
   provider after informed action; never log keys, raw private drafts or assets
   in telemetry by default. Avoid inferring publication from a click.

A hard-gate failure is a failure even with a 5/5 creative score.

### Improved human / model-assisted rubric (1–5)

Use the same anchored scale for each dimension: **1** unusable or misleading;
**3** understandable but needs meaningful edits; **5** directly usable for the
stated goal. Report dimension scores and gate failures separately. A weighted
summary is a prioritization aid, not a virality prediction.

| Dimension | Weight | 1 | 3 | 5 |
| --- | ---: | --- | --- | --- |
| User goal and agency | 25% | No clear next action or wrong goal | Goal present; substantial navigation/editing | Goal served with editable output and a clear, user-controlled next step |
| Specific value and grounding | 25% | Generic, unsupported, or misleading | One useful point; provenance or detail unclear | Concrete takeaway grounded in user material; claims can be checked |
| Clarity and hook | 20% | Confusing or buried payoff | Topic clear but generic | Opening makes the specific payoff clear without manipulation |
| Fit and accessibility | 15% | Unreadable or incompatible | Legible with some adjustment | Fits selected format and audience; captions readable throughout |
| Completion and recovery | 15% | Lost work, broken export or false success | Works with workaround | Save/export works, status is accurate and failure has a recovery path |

CTA is optional: score it only against the user's actual objective, not as a
mandatory question. For video, a reviewer watches the *exported file*, beginning,
middle and end, at normal speed and on a phone-sized screen; note safe-area
uncertainty because overlays vary by platform. Audio is N/A for silent clips.
For cross-modal output, compare specific claims and opening hooks, and report
mismatches separately. Low edit distance must never override a user's judgment.

### Trial protocol and success metrics

- Recruit at least 12 people for an initial diagnostic, spanning new/returning
  users, mobile/desktop and keyboard use. Give each a real or consented brief:
  a specific tip with evidence, a launch announcement, a long Unicode/link-rich
  post, an idea without evidence, and a multilingual brief. Include offline,
  denied storage, blocked popups/clipboard, absent codec and API failures. Use
  a fixed start (page opened) and stop (user confirms an accessible saved/exported
  asset and next action). Counterbalance task order and baseline/current versions.
- Record per task: elapsed seconds, completion by 180 seconds, hard failures,
  edits/regenerations, self-rated usefulness and confidence, and explicit
  acceptance. Count failures and timeouts in denominators. Separate rendering
  time from thinking time but report end-to-end time as primary. Do not claim
  users published or achieved reach based on an intent window or a local queue.
- Proposed launch targets, **not measured results**: at least 80% of eligible
  participants produce an accepted asset within 180 seconds; zero critical
  integrity/data-loss failures in the test set; at least 90% of exported files
  play on the tested device; show counts and confidence intervals, and expand
  sampling before asserting product-wide reliability. Compare with the existing
  workflow on the same briefs, not just against a threshold. Report failures by
  device, route and task; these small samples are diagnostic, not proof.
- Calculate first-pass acceptance = accepted with no regeneration / all started
  tasks, alongside acceptance after edits, median and 90th percentile time,
  and regeneration counts. Ask users whether edits were correction or intended
  personalization. A user withdrawing or timing out remains in the denominator.
- For judge calibration, have two independent human reviewers score a blinded
  stratified sample; adjudicate disagreements, measure agreement per dimension
  (e.g. weighted kappa where appropriate), compare judge/human disagreement and
  audit bias across dialects and languages. Use a fixed prompt/model version and
  holdout set; do not send private user data to a judge without explicit consent.
  A judge is not an authoritative fact checker. Human decisions govern launch.
- Instrument only with opt-in, aggregate events (start, local/AI generation,
  save/export result, explicit acceptance, failure category and coarse duration).
  No input text, file contents, account IDs, or keys. With telemetry off, run
  moderated tests or use local-only counters; document retention and deletion.

## Adversarial feature analysis

### Social Motion Studio

**Value hypothesis:** transform the user's own concise insight into a silent,
captioned clip that can be reviewed and exported without an account. Canvas and
local templates can reduce setup; they do not generate cinematic footage.

**What can defeat it:** the original single-topic templates insert generic
statements, unsupported myth/fact claims, and previously promised a DM/checklist
that may not exist. A fast export can therefore amplify misleading content.
The page previously implied a PNG *pack*, but its button exports the current
frame only. Duration is fixed at 2.5 seconds per scene in playback despite a
`durationSec` field in normalized scenes; longer copy may not be readable.
Record happens in real time, depends on Canvas/MediaRecorder and foreground
execution, can produce WebM rather than MP4, and contains no audio. Image loading
and provider availability are external dependencies; there is no guaranteed
quota or latency. Platform overlays, caption overflow, image license and mobile
render speed require actual device checks. The page's 30-second and provider
claims are marketing hypotheses, not validated service guarantees. Copy script
and a link to X Studio are a manual handoff, not automatic transfer.

**Shipped here:** two to eight newline-separated user lines become the actual
local scenes, enabling a specific no-key starting point without inventing facts;
the page explains the distinction and asks users to review claims. Removed the
invented DM/checklist promise, made the handle optional, corrected PNG fallback
and recording status, and stopped advertising a fixed recording duration on the
button. Single-topic template claims still require editing and review.

**Next experiments:** replace generic single-topic copy with clearly labeled
editable prompts rather than assertions; visibly flag placeholders and
unverified claims. Provide a duration/word-count preview and verify all scene
captions remain on screen; use scene durations consistently. Implement a real
script handoff with explicit consent, preserve video drafts locally with clear
storage limits, and test actual exported files and platform safe areas. Measure
brief-to-reviewed-video time, not just recording time. Avoid claiming a 3-minute
outcome until tested.

### X Studio launch and dropdown hardening

**Value hypothesis:** turn a grounded thought into an editable post, preserve it,
and hand it to X without requiring API setup. The dropdown fix restores access
to hooks, styles, CTAs and media presets; its DOM tests check population, not
that a user's idea becomes credible or is published.

**What can defeat it:** many hook and CTA templates contain braces and imply
personal experiences, numbers or future commitments the user may not have.
The existing "virality" score is a hand-coded mixture of arbitrary points and
unverified claims about ranking; it can reward form, media or questions while
missing falsehoods and useful concise writing. X's weighted character counting
is not equivalent to Unicode code points; thread numbering can exceed a limit
and URLs/emoji require special handling. The preview and number are not proof
that X accepts a post. A Canvas chart has illustrative bars; users must not
present default values as real measurements. Local drafts and reminders do not
sync across devices; storage can be disabled or full. Scheduled reminders need
the page open; popups and notifications can be blocked, and selecting a delivery
label does not dispatch a post. Browser API requests may fail CORS or require
current permissions; third-party API instructions and quotas can change. The X
intent does not attach media, publish automatically, or prove success. Cross-site
keys and webhook URLs are sensitive.

**Shipped here:** draft and reminder saves now report storage failure rather than
claiming success; the composer intent and direct API adapter no longer silently
cut text at 4,000 characters. Thread hard splits preserve Unicode code points.
The score is labeled as a heuristic, with an explicit warning; local scheduling
copy makes clear that it does not publish. These changes do not implement X's
weighted counter, validate that X accepts long URLs, fix thread numbering,
verify external API integrations or prove popup delivery.

**Next experiments:** make a single obvious path: write a concrete insight →
preview and resolve placeholders → save/copy/open X with explicit media and
length checks. Replace the numerical ranking score and unsupported algorithm
claims with transparent, optional checks for user goal, unresolved placeholders,
source-grounding reminders, and approximate platform limits. Use the official X
weighted-text implementation only after dependency review, and test links,
emoji, Unicode, premium limits and numbered threads. Redesign reminders so
blocked popups cannot be marked opened; guard against full storage, stale drafts
and queue failures. Verify external publishing adapters against current official
docs and user-authorized test accounts before calling them reliable. Add media
alt-text guidance, durable drafts, and an explicit safe delete/restore path.

## Practical priority order

1. **P0:** eliminate misleading content and silent loss/truncation; gate
   publishing on explicit user confirmation and truthful status. Add offline,
   quota, popup and recording-failure regression coverage.
2. **P1:** streamline the no-key, own-content path and repair honest export,
   text counting, media handoff and local recovery. Test real output on browsers.
3. **P2:** run the blinded human study and calibrate optional judges; instrument
   only with consent. Prioritize work by hard failures and acceptance under 180
   seconds, not assumed virality or provider benchmarks.
