# Working On integration roadmap

**Status:** Open — revisit before further implementation  
**Context:** The current setup is not yet the desired experience. The goal is a friction-free way to use the Working On tools with their relevant services, with minimal repeated setup or manual credentials. This is a backlog of aspirations and decisions, not a claim that the experience is finished.

## Current baseline

- Tasks List has a browser-local task set with explicit save/load to a private GitHub `tasksets` repository. A separate Google Tasks view uses a manually pasted, expiring OAuth access token; the two lists do not sync.
- Work List reuses the Scratchpad GitHub connection, with a personal access token fallback. It lists up to 100 accessible repositories and checks for file conflicts.
- Clipboard History is local until saved to a private `clips` repository using the same Scratchpad connection. Existing collections in `scratch` are not moved. Clipboard capture is constrained by browser permissions.
- Scratchpad uses a GitHub App connection and can save notes locally/offline. Calendar still needs a manually pasted, expiring Google token. Pomodoro is local; news uses public feeds and proxies.
- Repository creation can fail when the existing app lacks permission or access; private repositories may need to be created and added to the app manually. Details and setup links: [Working On integrations](../docs/working-on-integrations.md).

## Desired outcome

A clear, consistent experience across Working On: connect each relevant service as few times as possible, reuse existing authorizations safely, avoid copying short-lived tokens, and make data location and sync status obvious. Keep offline/local use useful and avoid losing or overwriting data. Exactly how the final flow looks is still to be decided with the user.

## Backlog

### Tasks List and `tasksets`

- [ ] Revisit the Tasks List experience: decide whether GitHub-backed task sets, Google Tasks, or both should be the primary workflow, and how they should appear together.
- [ ] Make saving to `tasksets` and returning to saved task sets easy to discover and use across devices; decide whether and how automatic sync should work.
- [ ] If Google Tasks integration remains, design an optional low-friction sign-in and decide whether synchronization with GitHub task sets is wanted. Do not assume the two lists are already synchronized.
- [ ] Define how local edits, remote edits, deletion, offline changes, and conflicts are handled without silent data loss.

### Work List and shared GitHub connection

- [ ] Review the end-to-end experience of reusing Scratchpad's GitHub App, including first-time setup, reconnecting on another device, token renewal, and selecting a repository.
- [ ] Minimize the need for personal access tokens; keep a clearly explained fallback only where needed.
- [ ] Improve repository selection beyond the current first 100 results and explain inaccessible repositories and permission changes.
- [ ] Preserve the existing load, pre-save conflict checks, and explicit overwrite protections.

### Clipboard History and `clips`

- [ ] Make saving and finding collections in the `clips` repository straightforward, reusing the shared GitHub connection.
- [ ] Decide whether and how to offer migration or access to older collections in `scratch`; do not move or delete them automatically.
- [ ] Improve feedback for offline saves, conflicts, and clipboard permission restrictions; never silently overwrite a remote collection.
- [ ] Review privacy and autosave safeguards: clips may contain secrets, and repository contents and Git history are readable by authorized collaborators.

### Shared service integration and setup

- [ ] Inventory all Working On tools and map each to its backend, required permissions, optional credentials, and local/offline behavior.
- [ ] Design a common connection/status experience with actionable setup, reconnect, permission, and error guidance. Link directly to the relevant official setup or access-artifact page when manual steps are unavoidable.
- [ ] Investigate Google Identity Services and an OAuth web client for Tasks and Calendar, including consent, authorized origins, scope selection, token expiry, and account setup. No client secret or refresh token should be embedded in the static site.
- [ ] Investigate GitHub App permissions and installation scope for creating and accessing `tasksets` and `clips`, including existing apps and organization restrictions. Prefer least privilege; explain when manual approval is unavoidable.
- [ ] Retain useful local/offline behavior for Scratchpad, tasks, clipboard, and timer; assess reliability and privacy of news feeds and third-party proxies.

## Acceptance criteria for a future implementation

- [ ] The agreed workflow is demonstrably simpler, and users can tell what is connected, where data is stored, and whether it is saved or pending.
- [ ] GitHub-backed tools reuse the existing connection where possible and provide actionable recovery when access or repository creation is denied.
- [ ] Google-backed features do not require repeated manual token copying if the selected authorization design supports avoiding it; unavoidable requirements and limitations are clear.
- [ ] Local and existing remote data are preserved; concurrent changes cannot be silently overwritten, and any migration requires an explicit, tested plan.
- [ ] Tests cover connection reuse, missing permissions, offline/error paths, and conflict handling; security and privacy implications are documented.

## Open decisions

- What should the preferred task workflow be: GitHub task sets, Google Tasks, or a unified view? Is two-way sync necessary?
- Should task and clipboard changes autosave by default, and what should happen offline?
- Should historical clips in `scratch` be migrated, linked, or left in place?
- Is configuring a Google Cloud OAuth client acceptable, or should Google services remain optional?
- What level of GitHub repository access and creation permission is acceptable for the shared app?
