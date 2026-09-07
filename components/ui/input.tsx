import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" type={type} className={cn('input', type === 'file' && 'file-input', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn('textarea', className)} {...props} />;
}

export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input data-slot="checkbox" type="checkbox" className={cn('ui-checkbox', className)} {...props} />;
}

export function Switch({ className, ...props }: Omit<ComponentProps<'input'>, 'type' | 'role'>) {
  return <input data-slot="switch" type="checkbox" role="switch" className={cn('ui-switch', className)} {...props} />;
}

export function Radio({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input data-slot="radio" type="radio" className={cn('ui-radio', className)} {...props} />;
}

export function Slider({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input data-slot="slider" type="range" className={cn('ui-slider', className)} {...props} />;
}
