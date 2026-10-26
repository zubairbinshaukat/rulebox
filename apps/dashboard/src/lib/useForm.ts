import { useCallback, useRef, useState } from "react";

/**
 * Small form state helper (no form library, Step 4): values, errors shown
 * after the first submit attempt (then live), a pending flag that disables
 * submit, and the last server error.
 */
export function useForm<V extends Record<string, unknown>, K extends string = Extract<keyof V, string>>(
  initial: V,
  validate: (values: V) => Partial<Record<K, string>>,
) {
  const [values, setValues] = useState<V>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const busy = useRef(false);

  const errors: Partial<Record<K, string>> = submitted ? validate(values) : {};

  const set = useCallback(<F extends keyof V>(field: F, value: V[F]) => {
    setValues((v) => ({ ...v, [field]: value }));
    setDirty(true);
  }, []);

  const reset = useCallback((next: V) => {
    setValues(next);
    setSubmitted(false);
    setServerError(null);
    setDirty(false);
  }, []);

  /** Runs `action` when the values are valid; focuses the first invalid field otherwise. */
  const submit = useCallback(
    async (action: (values: V) => Promise<void>, formEl?: HTMLFormElement | null) => {
      if (busy.current) return;
      setSubmitted(true);
      const errs = validate(values);
      if (Object.values(errs).some(Boolean)) {
        // Focus the first invalid control after render.
        requestAnimationFrame(() => {
          const scope: ParentNode = formEl ?? document.querySelector("[role=dialog]") ?? document;
          scope.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
        return;
      }
      busy.current = true;
      setPending(true);
      setServerError(null);
      try {
        await action(values);
        setDirty(false);
      } catch (e) {
        setServerError(e);
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [validate, values],
  );

  return { values, set, errors, submit, pending, serverError, setServerError, reset, dirty };
}
