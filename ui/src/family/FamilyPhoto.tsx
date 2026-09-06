import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type {
  FamilyPhoto as FamilyPhotoData,
  Portrait,
} from "../../../src/workspace-contract.js";
import { api, authorizedFetch } from "../api.js";
import "./family.css";

/* The family photo: one big group picture of everyone who has joined the
 * project, agents included. A portrait is an image a contributor's agent made
 * of itself and posted to the project's `family-photo` session; the gateway
 * lists them in join order and that order is your spot. Front row fills
 * first. Rows get wider and smaller toward the back, like a school photo on a
 * hill, and there is always a dotted outline where the next person goes.
 *
 * The background scene is a placeholder drawn in SVG until the real source
 * image is dropped in via the `scene` prop. */

export const SCENE = { width: 1600, height: 900 } as const;

interface Spot {
  x: number;
  y: number;
  scale: number;
  row: number;
}

/** Deterministic seat plan for `capacity` people. */
export function seats(capacity: number): Spot[] {
  const spots: Spot[] = [];
  let row = 0;
  let y = SCENE.height * 0.86;
  while (spots.length < capacity && row < 60) {
    const scale = Math.max(0.3, 1 - row * 0.048);
    const count = Math.min(80, 13 + row * 3);
    const pitch = 104 * scale;
    const width = (count - 1) * pitch;
    const start = SCENE.width / 2 - width / 2 + (row % 2 ? pitch / 2 : 0);
    for (let i = 0; i < count && spots.length < capacity; i++) {
      // a little hand-placed wobble, stable per seat
      const jitter = (hash(spots.length) % 9) - 4;
      spots.push({
        x: start + i * pitch + jitter,
        y: y + (jitter % 3),
        scale,
        row,
      });
    }
    y -= 58 * scale + 10;
    row++;
  }
  return spots;
}
function hash(n: number): number {
  let x = (n + 1) * 2654435761;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return x >>> 0;
}

export function FamilyPhoto({
  refreshKey,
  you,
  scene,
  openSession,
  compact = false,
}: {
  /** re-fetch when this changes (the workspace's receivedAt works well) */
  refreshKey: number;
  you: string;
  /** URL of the real scene image, once we have it */
  scene?: string;
  openSession?: (session: string) => void;
  compact?: boolean;
}) {
  const [data, setData] = useState<FamilyPhotoData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    api<FamilyPhotoData>("family", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setError(undefined);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : "Photo unavailable",
          );
      });
    return () => controller.abort();
  }, [refreshKey]);
  const plan = useMemo(() => seats(data?.capacity ?? 1000), [data?.capacity]);
  const portraits = data?.portraits ?? [];
  const yours = portraits.findIndex((p) => p.author === you);
  const nextOpen = portraits.length;
  return (
    <figure className={`family-photo ${compact ? "is-compact" : ""}`}>
      <div className="fp-frame">
        {scene ? (
          <img className="fp-scene" src={scene} alt="" />
        ) : (
          <PlaceholderScene />
        )}
        <div
          className="fp-people"
          style={{ aspectRatio: `${SCENE.width} / ${SCENE.height}` }}
        >
          {portraits.map((portrait, index) => {
            const spot = plan[index];
            if (!spot) return null;
            return (
              <Person
                key={portrait.id}
                portrait={portrait}
                spot={spot}
                mine={portrait.author === you}
                onOpen={openSession}
              />
            );
          })}
          {[0, 1, 2].map((offset) => {
            const spot = plan[nextOpen + offset];
            if (!spot) return null;
            return (
              <span
                key={`open-${offset}`}
                className={`fp-open ${offset === 0 && yours < 0 ? "is-yours" : ""}`}
                style={{
                  left: `${(spot.x / SCENE.width) * 100}%`,
                  top: `${(spot.y / SCENE.height) * 100}%`,
                  ["--s" as string]: spot.scale,
                  zIndex: 1000 - spot.row,
                }}
                title={offset === 0 && yours < 0 ? "Your spot" : "Open spot"}
              >
                {offset === 0 && yours < 0 && <Plus size={14} />}
              </span>
            );
          })}
        </div>
      </div>
      <figcaption>
        {error ? (
          <span className="muted">{error}</span>
        ) : data ? (
          <>
            <strong>{portraits.length}</strong> of {data.capacity} spots taken
            {yours >= 0 ? (
              <>
                {" · "}you're in row {plan[yours]!.row + 1}
              </>
            ) : (
              <>
                {" · "}row{" "}
                {plan[nextOpen]?.row === undefined
                  ? "?"
                  : plan[nextOpen]!.row + 1}{" "}
                has a spot for you
              </>
            )}
          </>
        ) : (
          <span className="muted">Developing the photo…</span>
        )}
      </figcaption>
    </figure>
  );
}

function Person({
  portrait,
  spot,
  mine,
  onOpen,
}: {
  portrait: Portrait;
  spot: Spot;
  mine: boolean;
  onOpen?: (session: string) => void;
}) {
  const src = usePortrait(portrait);
  return (
    <button
      type="button"
      className={`fp-person ${mine ? "is-mine" : ""}`}
      style={{
        left: `${(spot.x / SCENE.width) * 100}%`,
        top: `${(spot.y / SCENE.height) * 100}%`,
        ["--s" as string]: spot.scale,
        zIndex: 1000 - spot.row,
      }}
      title={
        portrait.caption
          ? `${portrait.author} — ${portrait.caption}`
          : portrait.author
      }
      aria-label={`${portrait.author}${portrait.caption ? `: ${portrait.caption}` : ""}`}
      onClick={() => onOpen?.(portrait.session)}
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span className="fp-initials">
          {portrait.author.slice(0, 2).toUpperCase()}
        </span>
      )}
    </button>
  );
}

/* Portrait bytes come through the authenticated gateway, so an <img src> alone
 * cannot fetch them. Load lazily when the person scrolls into view and keep the
 * object URL for the page's lifetime; content addressing means it never changes. */
const urls = new Map<string, Promise<string>>();
function usePortrait(portrait: Portrait): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const key = `${portrait.session}/${portrait.digest}`;
  useEffect(() => {
    let cancelled = false;
    let promise = urls.get(key);
    if (!promise) {
      promise = authorizedFetch(
        `portrait?session=${encodeURIComponent(portrait.session)}&digest=${portrait.digest}`,
      )
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return URL.createObjectURL(await response.blob());
        })
        .catch(() => "");
      urls.set(key, promise);
    }
    void promise.then((url) => {
      if (!cancelled && url) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [key, portrait.session, portrait.digest]);
  return src;
}

/** A hillside at golden hour, until the real photo arrives. */
function PlaceholderScene() {
  const ref = useRef<SVGSVGElement>(null);
  return (
    <svg
      ref={ref}
      className="fp-scene"
      viewBox={`0 0 ${SCENE.width} ${SCENE.height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="fp-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dfeef8" />
          <stop offset="0.6" stopColor="#f6efd9" />
          <stop offset="1" stopColor="#f3e2bd" />
        </linearGradient>
        <linearGradient id="fp-hill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9d29a" />
          <stop offset="1" stopColor="#6fae74" />
        </linearGradient>
        <linearGradient id="fp-hill2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fc48a" />
          <stop offset="1" stopColor="#58a06a" />
        </linearGradient>
      </defs>
      <rect width={SCENE.width} height={SCENE.height} fill="url(#fp-sky)" />
      <circle cx="1280" cy="190" r="86" fill="#fff3c4" opacity="0.9" />
      <ellipse cx="380" cy="230" rx="180" ry="46" fill="#fff" opacity="0.7" />
      <ellipse cx="470" cy="215" rx="120" ry="40" fill="#fff" opacity="0.75" />
      <ellipse cx="1000" cy="300" rx="150" ry="38" fill="#fff" opacity="0.55" />
      <path
        d="M0 560 C300 470 620 500 900 440 S1400 380 1600 470 V900 H0 Z"
        fill="url(#fp-hill2)"
      />
      <path
        d="M0 640 C260 560 560 640 900 560 S1380 500 1600 590 V900 H0 Z"
        fill="url(#fp-hill)"
      />
      {/* a tree on the left */}
      <rect x="150" y="470" width="22" height="120" rx="8" fill="#7a5a3a" />
      <circle cx="161" cy="450" r="74" fill="#4f9a5f" />
      <circle cx="120" cy="480" r="52" fill="#5aa76a" />
      <circle cx="205" cy="485" r="56" fill="#63b070" />
      {/* the axp mark as a signpost */}
      <rect x="1445" y="500" width="10" height="90" fill="#8a6a48" />
      <rect
        x="1410"
        y="480"
        width="80"
        height="34"
        rx="8"
        fill="#fbfcf8"
        stroke="#8a6a48"
        strokeWidth="3"
      />
      <text
        x="1450"
        y="504"
        textAnchor="middle"
        fontSize="18"
        fontWeight="700"
        fill="#3d7a52"
      >
        axp.
      </text>
    </svg>
  );
}
