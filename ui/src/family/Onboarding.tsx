import { useEffect, useState } from "react";
import { Camera, Check, Copy, Sparkles } from "lucide-react";
import type {
  FamilyPhoto as FamilyPhotoData,
  WorkspaceView,
} from "../../../src/workspace-contract.js";
import { api, useCommand } from "../api.js";
import { Dialog } from "../components.js";
import { FamilyPhoto } from "./FamilyPhoto.js";

/* Onboarding, rebuilt around one task: get your agent into the family photo.
 *
 *   1. Here is the photo, and here is your spot.
 *   2. Connect your agent to the project's family-photo session. The command
 *      is ready to copy; the step completes itself when the agent shows up.
 *   3. The task: your agent draws a portrait of itself and posts it. A
 *      maintainer (or the project's automation) sends the prompt the moment
 *      an agent arrives; a maintainer can send it from here.
 *
 * Fun, a little competitive (row 1 fills first), and it teaches every part of
 * the loop: connecting, permissions, blobs, comments. */

export const FAMILY_TASK_PROMPT = `Introduce yourself to the project by joining the family photo.

1. Make a portrait of yourself: a square image (PNG, at most 1 MB) of how you, the agent, see yourself. Use your own image tool, or the project's: in the axp-avatar repo, \`python tools/compose.py --seed <your principal id> --transparent --out me.png\` draws you in the family's style.
2. Upload it to this session with _axp/blobPut (mediaType image/png or image/svg+xml).
3. Post one comment with _axp/comment whose body is the image reference followed by a one-line caption, for example:
   ![me](axp-blob:/…/<sha256>) Parser fixer. Likes small diffs.

That comment is your spot in the photo. One portrait per person; the earlier you post, the closer to the front you stand.`;

export function Onboarding({
  workspace,
  close,
  refresh,
  openSession,
}: {
  workspace: WorkspaceView;
  close: () => void;
  refresh: () => void;
  openSession: (session: string) => void;
}) {
  const you = workspace.principal.id;
  const [family, setFamily] = useState<FamilyPhotoData>();
  useEffect(() => {
    api<FamilyPhotoData>("family").then(setFamily, () => setFamily(undefined));
  }, [workspace.receivedAt]);
  const session = family?.sessions[0] ?? "family-photo";
  const inPhoto = family?.portraits.some((p) => p.author === you) ?? false;
  const agent = workspace.executors.find(
    (executor) =>
      executor.owner === you &&
      executor.online &&
      executor.expiresAt > Date.now(),
  );
  const command = `axp park ${session} --profile .axp/contributor.json --native -- YOUR_ACP_AGENT`;
  const [copied, setCopied] = useState(false);
  const send = useCommand(refresh);
  const maintainer = workspace.principal.role === "maintainer";
  const [sent, setSent] = useState(false);
  return (
    <Dialog title="Join the family photo" close={close}>
      <div className="dialog-body onboarding">
        <div className="onboarding-step">
          <span>{inPhoto ? <Check size={14} /> : "01"}</span>
          <div>
            <h3>There's a spot for you</h3>
            <p>
              Everyone who joins this project adds themselves to one big photo,
              agents and people alike. Front row fills first.
            </p>
            <FamilyPhoto
              refreshKey={workspace.receivedAt}
              you={you}
              compact
              openSession={(id) => {
                close();
                openSession(id);
              }}
            />
          </div>
        </div>
        <div className="onboarding-step">
          <span>{agent ? <Check size={14} /> : "02"}</span>
          <div>
            <h3>{agent ? `${agent.name} is here` : "Connect your agent"}</h3>
            <p>
              {agent
                ? "Your agent is connected to this project. On to the fun part."
                : "From your checkout, connect your ACP agent to the photo session with your contributor profile. This step ticks itself when the agent arrives."}
            </p>
            {!agent && (
              <>
                <div className="onboarding-command">
                  <code>{command}</code>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => {
                      void navigator.clipboard?.writeText(command).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                      });
                    }}
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="fine-print">
                  <span className="onboarding-wait" /> Waiting for your agent…
                  Native tools run with your user permissions; use --image for
                  an offline container instead.
                </p>
              </>
            )}
          </div>
        </div>
        <div className="onboarding-step">
          <span>{inPhoto ? <Check size={14} /> : "03"}</span>
          <div>
            <h3>Your first task: a self-portrait</h3>
            <p>
              Your agent draws a picture of itself with whatever image tool it
              has, uploads it to the session and posts it with a caption. That
              post is your place in the photo. Maintainers approve any tool it
              asks to use, the same as for real work.
            </p>
            <details className="onboarding-prompt">
              <summary>The prompt your agent receives</summary>
              <pre>{FAMILY_TASK_PROMPT}</pre>
            </details>
            {maintainer && !inPhoto && (
              <button
                type="button"
                className="button small"
                disabled={send.busy || sent}
                onClick={() => {
                  void send
                    .send(session, {
                      kind: "prompt",
                      text: FAMILY_TASK_PROMPT,
                      mode: "start",
                    })
                    .then((ok) => {
                      if (ok) setSent(true);
                    });
                }}
              >
                <Sparkles size={13} />{" "}
                {sent ? "Task sent" : "Send the task now"}
              </button>
            )}
            {send.error && (
              <div className="notice error" role="alert">
                {send.error}
              </div>
            )}
          </div>
        </div>
        <button
          className="button primary full"
          onClick={() => {
            close();
            openSession(session);
          }}
        >
          <Camera size={16} /> Open the photo session
        </button>
      </div>
    </Dialog>
  );
}
