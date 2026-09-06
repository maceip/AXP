/* The tools in the pencil case, drawn as simple SVG. Each sits in a 40×120
 * frame with its tip at the top so the tray can hide the lower body and let
 * the tool rise when hovered or selected. Colours come in as CSS variables so
 * ink changes crossfade without re-rendering. */

export type Tool = "highlighter" | "stamp" | "note";

export function Highlighter({ ink }: { ink: string }) {
  return (
    <svg viewBox="0 0 40 120" width="40" height="120" aria-hidden="true">
      {/* chisel tip */}
      <path d="M14 22 L26 22 L28 34 L12 34 Z" fill={ink} />
      <path d="M12 34 h16 v10 H12 z" fill="#e9e6df" />
      {/* barrel */}
      <rect
        x="9"
        y="44"
        width="22"
        height="70"
        rx="6"
        fill="#f7f5ef"
        stroke="#d6d2c8"
      />
      <rect x="9" y="58" width="22" height="9" fill={ink} opacity="0.9" />
      <rect x="9" y="44" width="22" height="70" rx="6" fill="url(#pen-shine)" />
      <path d="M14 22 L26 22 L20 12 Z" fill={ink} opacity="0.85" />
    </svg>
  );
}

export function Stamp({ ink }: { ink: string }) {
  return (
    <svg viewBox="0 0 40 120" width="40" height="120" aria-hidden="true">
      {/* rubber face */}
      <rect x="6" y="22" width="28" height="10" rx="3" fill={ink} />
      {/* block */}
      <rect x="8" y="32" width="24" height="12" rx="3" fill="#8a6b4f" />
      {/* handle */}
      <rect x="15" y="44" width="10" height="26" rx="4" fill="#c9a882" />
      <ellipse cx="20" cy="76" rx="11" ry="7" fill="#b9946e" />
      <rect x="9" y="76" width="22" height="38" rx="9" fill="#c9a882" />
      <rect x="9" y="76" width="22" height="38" rx="9" fill="url(#pen-shine)" />
    </svg>
  );
}

export function NotePen({ ink }: { ink: string }) {
  return (
    <svg viewBox="0 0 40 120" width="40" height="120" aria-hidden="true">
      {/* fine tip */}
      <path d="M18 14 L22 14 L24 30 L16 30 Z" fill="#2f2a25" />
      <path d="M16 30 h8 v8 h-8 z" fill="#cfcac0" />
      {/* barrel with a note-yellow band */}
      <rect
        x="11"
        y="38"
        width="18"
        height="78"
        rx="5"
        fill="#fbf7ea"
        stroke="#d6d2c8"
      />
      <rect x="11" y="50" width="18" height="10" fill={ink} />
      <rect
        x="11"
        y="38"
        width="18"
        height="78"
        rx="5"
        fill="url(#pen-shine)"
      />
    </svg>
  );
}

/** Shared gradient so every tool has the same soft cylinder shading. */
export function PenDefs() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: "absolute" }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="pen-shine" x1="0" x2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.08" />
          <stop offset="0.35" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.7" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.14" />
        </linearGradient>
        {/* ink texture for stamps: speckled coverage like a real rubber stamp */}
        <filter id="stamp-ink" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            seed="7"
            result="noise"
          />
          <feColorMatrix
            in="noise"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.25"
            result="speckle"
          />
          <feComposite in="SourceGraphic" in2="speckle" operator="in" />
        </filter>
      </defs>
    </svg>
  );
}
