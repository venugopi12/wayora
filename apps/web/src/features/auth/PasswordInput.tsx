import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState } from 'react';
import { IconButton, Input, type InputProps } from '@wayora/ui';

/**
 * Password field with a show/hide toggle. The toggle is a real button with a
 * changing name and `aria-pressed`, so screen-reader users know the state.
 * Use inside <Field>; pass `autoComplete="current-password"` or `"new-password"`.
 */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'trailing'>>(
  function PasswordInput(props, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <Input
        ref={ref}
        {...props}
        type={visible ? 'text' : 'password'}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className="pr-1"
        trailing={
          <IconButton
            type="button"
            size="sm"
            variant="ghost"
            label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            icon={visible ? <EyeOff /> : <Eye />}
            onClick={() => setVisible((v) => !v)}
          />
        }
      />
    );
  },
);
