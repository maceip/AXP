import { useEffect, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import "./grove.css";

/* Grove: thin React wrappers over the classes in grove.css. Anything a plain
 * element can do, the class does; these exist so call sites read as
 * components and so the dialog blob clip-path is mounted once. */

export function GroveDefs() {
  return (
    <svg
      style={{ position: "absolute", width: 0, height: 0 }}
      aria-hidden="true"
    >
      <defs>
        {/* Organic blob for dialogs; objectBoundingBox so it scales with the box. */}
        <clipPath id="grove-blob" clipPathUnits="objectBoundingBox">
          <path d="M0.501,0.005 L0.501,0.005 L0.523,0.005 L0.549,0.006 C0.704,0.01,0.796,0.017,0.825,0.027 L0.827,0.028 C0.872,0.045,0.939,0.044,0.978,0.17 C1,0.254,1,0.365,0.99,0.505 L0.988,0.513 C0.979,0.558,0.971,0.598,0.965,0.633 C0.956,0.689,0.979,0.77,0.964,0.865 C0.953,0.928,0.921,0.966,0.869,0.979 C0.821,0.986,0.773,0.992,0.726,0.995 L0.712,0.996 L0.694,0.997 C0.648,1,0.586,1,0.507,1 L0.501,1 L0.464,1 C0.385,1,0.325,0.998,0.283,0.995 C0.234,0.992,0.184,0.987,0.133,0.979 C0.081,0.966,0.05,0.928,0.039,0.865 C0.023,0.77,0.047,0.689,0.037,0.633 C0.031,0.595,0.023,0.552,0.013,0.505 C-0.006,0.365,-0.002,0.254,0.024,0.17 C0.064,0.045,0.13,0.045,0.174,0.028 L0.175,0.028 C0.204,0.017,0.303,0.009,0.474,0.005 L0.501,0.005" />
        </clipPath>
      </defs>
    </svg>
  );
}

type Variant = "default" | "primary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

export function Button({
  variant = "default",
  size = "md",
  block,
  icon,
  loading,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  icon?: boolean;
  loading?: boolean;
}) {
  const classes = [
    "grove-btn",
    variant !== "default" ? `grove-btn-${variant}` : "",
    size !== "md" ? `grove-btn-${size}` : "",
    block ? "grove-btn-block" : "",
    icon ? "grove-btn-icon" : "",
    loading ? "is-loading" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button type="button" {...rest} className={classes} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} className={`grove-input ${props.className ?? ""}`} />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`grove-textarea ${props.className ?? ""}`}
    />
  );
}

export function Switch({
  checked,
  onChange,
  labels = ["On", "Off"],
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  labels?: [string, string];
  "aria-label": string;
}) {
  return (
    <label className="grove-switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="handle" />
      <span className="on">{labels[0]}</span>
      <span className="off">{labels[1]}</span>
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="grove-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="box" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8.5l3.2 3L13 4.5" />
        </svg>
      </span>
      {children}
    </label>
  );
}

export type Activity =
  "working" | "permission" | "review" | "ready" | "waiting" | "archived";

export function Tag({
  activity,
  children,
}: {
  activity?: Activity;
  children: ReactNode;
}) {
  return (
    <span className={`grove-tag ${activity ? `grove-tag-${activity}` : ""}`}>
      {children}
    </span>
  );
}

export function Ribbon({
  paper,
  children,
}: {
  paper?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`grove-ribbon ${paper ? "grove-ribbon-paper" : ""}`}>
      {children}
    </span>
  );
}

export function Speech({
  who,
  agent,
  children,
}: {
  who: string;
  agent?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`grove-speech ${agent ? "from-agent" : ""}`}>
      <span className="who">{who}</span>
      {children}
    </div>
  );
}

/** A native <dialog> clipped to the blob. Closes on Escape and on clicks outside. */
export function BlobDialog({
  title,
  description,
  close,
  children,
  actions,
}: {
  title: string;
  description?: string;
  close: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="grove-dialog"
      aria-label={title}
      onCancel={close}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
    >
      <div className="grove-dialog-shell">
        <div className="grove-dialog-blob">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
          {children}
          {actions && <div className="grove-dialog-actions">{actions}</div>}
        </div>
      </div>
    </dialog>
  );
}

export function Vine() {
  return <div className="grove-vine" role="separator" />;
}
