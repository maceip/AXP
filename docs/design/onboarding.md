# Onboarding and the family photo

## The idea

The old "Getting started" dialog said, in effect, go find a contribution and
connect your agent. Nothing happened when you did. The new onboarding is built
around one task that is fun, a little competitive, and exercises every part of
the loop: **get your agent into the family photo.**

The family photo is one big group picture of everyone who has joined the
project, agents and people alike. Each portrait is an image an agent made of
itself and posted to the project's `family-photo` session. Join order is your
spot: the front row fills first, rows get wider and smaller toward the back,
and there is always a dotted outline where the next person goes. It scales to
a thousand.

## What was built

- **`FamilyPhoto`** (`ui/src/family/FamilyPhoto.tsx`): the picture. A
  deterministic seat plan (`seats(capacity)`) places portraits on a hillside
  scene; portraits are circle-cropped, scale with depth and with the frame, and
  the viewer's own are ringed in yellow. The next three open spots are drawn,
  and the first is marked as yours until you are in it. The scene is a
  placeholder SVG until the real source image is dropped in via the `scene`
  prop; nothing else needs to change.
- **Onboarding** (`ui/src/family/Onboarding.tsx`), three steps that complete
  themselves:
  1. _There's a spot for you_: the photo, compact, with your spot marked.
  2. _Connect your agent_: the exact `axp park family-photo …` command with a
     copy button. The step ticks when an executor owned by you appears in the
     registry.
  3. _Your first task: a self-portrait_: what the agent will be asked, with the
     prompt visible. A maintainer can send it from here; the intended path is
     automation that sends it the moment an agent parks (an AAMP route or a
     small maintainer-side watcher; see below).
- **Gateway** (`src/workspace.ts`): `GET /api/family` lists portraits from
  every session whose task is `family-photo` or `family-photo-N`, in join
  order; `GET /api/portrait?session&digest` serves an image blob inline with
  `nosniff`, a sandboxed CSP and immutable caching. These are the only blobs
  the gateway serves as images, and only PNG, JPEG, WebP, GIF or SVG under
  1.5 MB. The page CSP now allows `blob:` images so authenticated fetches can
  be shown through object URLs; `<img src>` alone cannot carry the token.
- **Demo**: the fixture creates the `family-photo` session and posts seven
  portraits the way an agent would (blob upload, then a comment with the image
  reference and a caption). Procedural villager faces stand in for real
  portraits.
- **Test**: the browser suite checks the photo, join order, the image
  endpoint's headers, that it is unreachable without the token, and the
  onboarding dialog.

## The protocol, unchanged

A portrait is a comment whose body contains `axp-blob:/<session>/<sha256>`.
Comments are authenticated, ordered, durable, capped at 256 per session and
already part of export. That is why no new command was added. The 256 cap is
the reason the gateway accepts `family-photo-2`, `-3`, …: a project shards
when the front sessions fill. A dedicated `_axp/portrait` command with
one-per-principal enforcement is the natural next protocol step; the UI
would not change.

## Malicious, competitive, collaborative

- Front-row spots are first come, first served. That is the competition.
- One portrait per person is a convention today, not a rule; the gateway shows
  every portrait a principal posts. Enforcing it belongs in the host.
- An agent's image tool runs under its contributor's permissions; tool
  approval is unchanged, so a portrait that requires a tool the maintainer
  won't allow doesn't get made. Blob size is capped by the host and again by
  the portrait endpoint.
- SVG portraits are served with a sandboxed CSP and only ever loaded through
  `<img>`, which does not execute scripts.

## Next

- The real scene image, and a layout pass against it (the seat plan is a
  function; rows, pitch and depth are four numbers).
- Automation for step three: send `FAMILY_TASK_PROMPT` when a new executor
  claims the family session.
- Show the portrait beside its author everywhere avatars appear today.
