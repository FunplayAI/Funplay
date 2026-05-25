import { Input as BaseInput } from '@base-ui/react/input';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { Check, ChevronDown } from 'lucide-react';
import { type ComponentProps, type JSX, type ReactNode } from 'react';
import { cx } from './utils';

export type TextFieldProps = Omit<ComponentProps<typeof BaseInput>, 'className' | 'onValueChange'> & {
  label: ReactNode;
  helper?: ReactNode;
  className?: string;
  inputClassName?: string;
  onValueChange?: (value: string) => void;
};

export function TextField(props: TextFieldProps): JSX.Element {
  const { label, helper, className, inputClassName, onValueChange, ...inputProps } = props;

  return (
    <label className={cx('fp-field', className)}>
      <span className="fp-field-label">{label}</span>
      <BaseInput
        {...inputProps}
        className={cx('fp-input', inputClassName)}
        onValueChange={(value) => onValueChange?.(value)}
      />
      {helper ? <span className="fp-field-helper">{helper}</span> : null}
    </label>
  );
}

export type TextAreaFieldProps = Omit<ComponentProps<'textarea'>, 'className' | 'onChange'> & {
  label: ReactNode;
  helper?: ReactNode;
  className?: string;
  textareaClassName?: string;
  onValueChange?: (value: string) => void;
};

export type TextAreaControlProps = Omit<ComponentProps<'textarea'>, 'className' | 'onChange'> & {
  className?: string;
  onValueChange?: (value: string) => void;
};

export function TextAreaControl(props: TextAreaControlProps): JSX.Element {
  const { className, onValueChange, ...textareaProps } = props;

  return (
    <textarea
      {...textareaProps}
      className={cx('fp-textarea', className)}
      onChange={(event) => onValueChange?.(event.target.value)}
    />
  );
}

export function TextAreaField(props: TextAreaFieldProps): JSX.Element {
  const { label, helper, className, textareaClassName, onValueChange, ...textareaProps } = props;

  return (
    <label className={cx('fp-field', className)}>
      <span className="fp-field-label">{label}</span>
      <textarea
        {...textareaProps}
        className={cx('fp-textarea', textareaClassName)}
        onChange={(event) => onValueChange?.(event.target.value)}
      />
      {helper ? <span className="fp-field-helper">{helper}</span> : null}
    </label>
  );
}

export type SelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

export function SelectField(props: {
  label: ReactNode;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: ReactNode;
  helper?: ReactNode;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  const selectedLabel = props.options.find((option) => option.value === props.value)?.label ?? props.placeholder ?? props.value;

  return (
    <div className={cx('fp-field', props.className)}>
      <span className="fp-field-label">{props.label}</span>
      <SelectPrimitive.Root
        value={props.value}
        disabled={props.disabled}
        onValueChange={(value: string | null) => {
          if (typeof value === 'string') {
            props.onValueChange(value);
          }
        }}
      >
        <SelectPrimitive.Trigger className="fp-select-trigger">
          <SelectPrimitive.Value className="fp-select-value">{selectedLabel}</SelectPrimitive.Value>
          <SelectPrimitive.Icon className="fp-select-chevron">
            <ChevronDown size={14} aria-hidden="true" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Positioner sideOffset={6} align="start" className="fp-select-positioner">
            <SelectPrimitive.Popup className="fp-select-popup">
              <SelectPrimitive.List className="fp-select-list">
                {props.options.map((option) => (
                  <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className="fp-select-item">
                    <SelectPrimitive.ItemIndicator className="fp-select-item-indicator">
                      <Check size={13} aria-hidden="true" />
                    </SelectPrimitive.ItemIndicator>
                    <SelectPrimitive.ItemText className="fp-select-item-text">{option.label}</SelectPrimitive.ItemText>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.List>
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {props.helper ? <span className="fp-field-helper">{props.helper}</span> : null}
    </div>
  );
}

export function CheckboxField(props: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <label className={cx('fp-checkbox-field', props.disabled && 'is-disabled', props.className)}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onCheckedChange(event.currentTarget.checked)}
      />
      <span className="fp-checkbox-copy">
        <span className="fp-checkbox-label">{props.label}</span>
        {props.description ? <span className="fp-checkbox-description">{props.description}</span> : null}
      </span>
    </label>
  );
}

export function SwitchField(props: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className={cx('fp-switch-field', props.disabled && 'is-disabled')}>
      <SwitchPrimitive.Root
        className="fp-switch"
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(checked: boolean) => props.onCheckedChange(checked)}
      >
        <SwitchPrimitive.Thumb className="fp-switch-thumb" />
      </SwitchPrimitive.Root>
      <span className="fp-switch-copy">
        <span className="fp-switch-label">{props.label}</span>
        {props.description ? <span className="fp-switch-description">{props.description}</span> : null}
      </span>
    </label>
  );
}

export function ToggleSwitch(props: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <SwitchPrimitive.Root
      aria-label={props.label}
      title={props.label}
      className={cx('fp-switch', 'fp-toggle-switch', props.className)}
      checked={props.checked}
      disabled={props.disabled}
      onCheckedChange={(checked: boolean) => props.onCheckedChange(checked)}
    >
      <SwitchPrimitive.Thumb className="fp-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
