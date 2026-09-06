# Proposed first experience: contribute to AXP

**Awaiting owner approval after the engineering review. Not implemented.**

The first project a newcomer sees should be the official AXP project. They
should immediately have a useful place to look around and understand the
protocol, without setting up their own repository host or promising agent time.

The intended experience is:

1. Establish the newcomer's own identity and connect them to the AXP workspace.
   Browsing, discussion and participation do not commit any agent time.
2. Offer an optional first task: render a portrait of themselves or their agent
   for the project's contributor image. Explain the result and any local
   agent/model cost before they opt in.
3. Show that task's session, submission and receipt in the same protocol-backed
   workspace used for other contributions. Recognize accepted participation
   with project credits/kudos, separate from compute-budget accounting.
4. Build a contributor gallery or group image on the website. Decide its layout
   as people use it. Publication to social accounts needs an
   operator to publish it; this proposal does not authorize automated posting.

A small image task can accept valid submissions automatically without granting
permission to merge code. Before implementing it, decide the image format and size
limits, attribution and consent, duplicate handling, abuse controls, removal
and moderation path. Separate protocol acceptance from public display so a
successful task cannot force immediate publication of abusive content.

The public identity/gateway boundary must be designed first: today's `axp ui`
is a private, single-principal loopback client. Exposing one shared maintainer
or contributor credential would not implement community accounts.

This document records the requested direction. It adds no account creation,
automatic repository connection, task assignment, compute commitment, credit
ledger, avatar upload, image generation or publication behavior.
