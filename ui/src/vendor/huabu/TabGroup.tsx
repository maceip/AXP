// Copyright (c) Microsoft Corporation. Licensed under the MIT license.
// Adapted from Huabu TabGroup.tsx at a3c411e1f655191344285141f08c4738fa6015f7.
// AXP adds tab semantics, roving focus and arrow-key navigation; styling uses local tokens.
import { useId, useRef } from "react";

export function TabGroup<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          id={`${id}-${option.value}`}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          aria-controls="contribution-panel"
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % options.length
                : event.key === "ArrowLeft"
                  ? (index + options.length - 1) % options.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? options.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            onChange(options[next]!.value);
            buttons.current[next]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
