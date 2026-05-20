import { Button as BaseButton } from '@base-ui/react/button';
import { LoaderCircle } from 'lucide-react';
import { type ComponentProps, type JSX, type ReactNode } from 'react';
import { cx } from './utils';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'compact';

export type ButtonProps = Omit<ComponentProps<typeof BaseButton>, 'className'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  className?: string;
};

export function Button(props: ButtonProps): JSX.Element {
  const {
    variant = 'secondary',
    size = 'md',
    leadingIcon,
    trailingIcon,
    loading = false,
    className,
    children,
    disabled,
    type,
    ...buttonProps
  } = props;

  return (
    <BaseButton
      {...buttonProps}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={cx('fp-button', `fp-button-${variant}`, `fp-button-${size}`, loading && 'is-loading', className)}
    >
      {loading ? <LoaderCircle className="fp-button-spinner" size={14} aria-hidden="true" /> : leadingIcon ? <span className="fp-button-icon">{leadingIcon}</span> : null}
      <span className="fp-button-label">{children}</span>
      {trailingIcon ? <span className="fp-button-icon trailing">{trailingIcon}</span> : null}
    </BaseButton>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'children' | 'leadingIcon' | 'trailingIcon'> & {
  label: string;
  icon: ReactNode;
};

export function IconButton(props: IconButtonProps): JSX.Element {
  const { label, icon, size = 'compact', variant = 'ghost', className, ...buttonProps } = props;

  return (
    <Button
      {...buttonProps}
      aria-label={label}
      title={label}
      variant={variant}
      size={size}
      className={cx('fp-icon-button', className)}
    >
      {icon}
    </Button>
  );
}
