import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type NativeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'>;

interface PasswordInputProps extends NativeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Classes for the <input> (padding-right for the toggle is added automatically). */
  inputClassName?: string;
  /** Optional decorative icon shown on the left (remember to add left padding in inputClassName). */
  leftIcon?: React.ReactNode;
  /** Controlled visibility (optional). */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

/** Password field with an accessible show/hide toggle. */
export const PasswordInput = ({
  value,
  onChange,
  inputClassName = '',
  leftIcon,
  visible,
  onVisibleChange,
  inputRef,
  className,
  ...rest
}: PasswordInputProps) => {
  const [localVisible, setLocalVisible] = useState(false);
  const shown = visible ?? localVisible;
  const toggle = () => {
    const next = !shown;
    if (onVisibleChange) onVisibleChange(next);
    if (visible === undefined) setLocalVisible(next);
  };

  return (
    <div className={`relative ${className ?? ''}`}>
      {leftIcon && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">
          {leftIcon}
        </span>
      )}
      <input
        {...rest}
        ref={inputRef}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClassName} pr-12`}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
      >
        {shown ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
};

export interface PasswordRule {
  label: string;
  ok: boolean;
}

/** Staff login password rules (mirror of `validate_new_password` on the server). */
export const staffPasswordRules = (pwd: string): PasswordRule[] => [
  { label: 'At least 8 characters', ok: pwd.length >= 8 },
  { label: 'Contains a letter', ok: /[A-Za-z]/.test(pwd) },
  { label: 'Contains a number', ok: /\d/.test(pwd) },
];

/** Checklist of password rules, announced politely to screen readers. */
export const PasswordRules = ({ rules, id }: { rules: PasswordRule[]; id?: string }) => (
  <ul id={id} className="flex flex-wrap gap-2" aria-live="polite">
    {rules.map((r) => (
      <li
        key={r.label}
        className={`rounded-full px-2.5 py-1 text-xs font-medium ${
          r.ok ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
        }`}
      >
        <span aria-hidden="true">{r.ok ? '✓ ' : '• '}</span>
        {r.label}
        <span className="sr-only">{r.ok ? ' (met)' : ' (not met)'}</span>
      </li>
    ))}
  </ul>
);
