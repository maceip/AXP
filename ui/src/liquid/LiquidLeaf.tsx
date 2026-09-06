import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import "./liquid-leaf.css";

/* Liquid Leaf: React bindings for the surface described in liquid-leaf.css.
 *
 * <LeafDefs/>   mounts the SVG filters (goo, wobble) once per document
 * <Leaf/>       a surface; variants map to the CSS classes
 * useLeafLight  moves the specular highlight toward the pointer
 * useLeafPress  squash on press, spring on release, wobble on landing */

export function LeafDefs() {
  return (
    <svg className="leaf-defs" aria-hidden="true" focusable="false">
      <defs>
        {/* Metaballs: blur the alpha, then push it back to a hard edge. */}
        <filter id="leaf-goo" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
        {/* A slow ripple: low-frequency turbulence displacing the surface. */}
        <filter id="leaf-wobble" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.02"
            numOctaves="2"
            seed="3"
            result="noise"
          >
            <animate
              attributeName="baseFrequency"
              dur="0.9s"
              values="0.012 0.02;0.02 0.03;0.012 0.02"
              repeatCount="indefinite"
            />
          </feTurbulence>
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="6"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}

/** Specular highlight follows the pointer; snaps back when it leaves. */
export function useLeafLight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const onPointerMove = useCallback((event: PointerEvent<T>) => {
    const node = ref.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * 100;
    const y = ((event.clientY - box.top) / box.height) * 100;
    node.style.setProperty("--leaf-light-x", `${x.toFixed(1)}%`);
    node.style.setProperty("--leaf-light-y", `${y.toFixed(1)}%`);
  }, []);
  const onPointerLeave = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.style.removeProperty("--leaf-light-x");
    node.style.removeProperty("--leaf-light-y");
  }, []);
  return { ref, onPointerMove, onPointerLeave };
}

/** Squash while pressed; on release play the spring and a short wobble. */
export function useLeafPress() {
  const [state, setState] = useState<"rest" | "pressed" | "releasing">("rest");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onPointerDown = useCallback(() => setState("pressed"), []);
  const release = useCallback(() => {
    setState((current) => (current === "pressed" ? "releasing" : current));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("rest"), 650);
  }, []);
  const className =
    state === "pressed"
      ? "is-pressed"
      : state === "releasing"
        ? "is-releasing is-wobbling"
        : "";
  return {
    className,
    onPointerDown,
    onPointerUp: release,
    onPointerCancel: release,
  };
}

type Variant = "button" | "pill" | "card" | "dot";
const TAGS: Record<Variant, "button" | "span" | "div"> = {
  button: "button",
  pill: "span",
  card: "div",
  dot: "span",
};

export function Leaf({
  variant,
  className = "",
  children,
  live,
  off,
  style,
  ...rest
}: {
  variant: Variant;
  className?: string;
  children?: ReactNode;
  /** dot only: breathe while live */
  live?: boolean;
  /** dot only: dry, sandy colour when offline */
  off?: boolean;
  style?: CSSProperties;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  "aria-label"?: string;
}) {
  const light = useLeafLight<HTMLElement>();
  const press = useLeafPress();
  const interactive = variant === "button";
  const classes = [
    "leaf",
    `leaf-${variant}`,
    live ? "is-live" : "",
    off ? "is-off" : "",
    interactive ? press.className : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return createElement(
    TAGS[variant],
    {
      ...rest,
      ref: light.ref,
      className: classes,
      style,
      ...(variant === "button" ? { type: "button" } : {}),
      ...(variant === "button" || variant === "card"
        ? {
            onPointerMove: light.onPointerMove,
            onPointerLeave: (event: PointerEvent<HTMLElement>) => {
              light.onPointerLeave();
              if (interactive) press.onPointerCancel();
              void event;
            },
          }
        : {}),
      ...(interactive
        ? {
            onPointerDown: press.onPointerDown,
            onPointerUp: press.onPointerUp,
          }
        : {}),
    },
    children,
  );
}
