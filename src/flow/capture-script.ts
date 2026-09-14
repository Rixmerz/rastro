// Runs inside the page via `context.addInitScript`/`page.evaluate`. Keep this
// function free of references to anything outside its own body — Playwright
// serializes it with `toString()` and runs it in the page's JS realm, so any
// outer-scope binding (imports, module-level consts) would be undefined there.
//
// It listens for the DOM events a human capture session cares about and
// reports each one, with a durable locator bundle, to the Node-side
// `__rastroCapture` binding installed by `FlowController`.

export function installRastroCapture(): void {
  const w = window as unknown as {
    __rastroCaptureCleanup?: () => void;
    __rastroCapture?: (event: {
      kind: string;
      bundle: Record<string, unknown>;
      value?: string;
      isPassword: boolean;
      ts: number;
    }) => void;
  };
  // Re-arms rather than no-oping on a flag: a popup's very first navigation
  // can lose the race with `context.addInitScript` (the same CDP-attach gap
  // recorder.ts hits), leaving an earlier run's listeners attached to a
  // document that never becomes interactive while a `__rastroCaptureInstalled`
  // flag would have looked "done" forever. Tearing down whatever the last
  // run wired up and re-adding fresh listeners makes every call — from
  // `addInitScript`, from the per-tab replay loop, or from a caller retrying
  // after a new document — converge on one working set instead of skipping.
  w.__rastroCaptureCleanup?.();

  // Suppresses the `submit` event fired by the browser's own default action
  // right after a click on a submit button: without this, that one user
  // gesture would be recorded twice (click + submit).
  let lastSubmitClick: { form: Element | null; ts: number } | null = null;

  const attr = (el: Element, name: string): string | undefined => el.getAttribute(name) ?? undefined;

  function role(el: Element): string {
    const explicit = attr(el, 'role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && attr(el, 'href') !== undefined) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    return tag;
  }

  function accessibleName(el: Element): string | undefined {
    const ariaLabel = attr(el, 'aria-label');
    if (ariaLabel) return ariaLabel;

    const labelledby = attr(el, 'aria-labelledby');
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter((t): t is string => Boolean(t))
        .join(' ');
      if (text) return text;
    }

    if ('labels' in el) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const text = Array.from(labels)
          .map((l) => l.textContent?.trim())
          .filter(Boolean)
          .join(' ');
        if (text) return text;
      }
    }

    const placeholder = attr(el, 'placeholder');
    if (placeholder) return placeholder;

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      if ((type === 'submit' || type === 'button') && (el as HTMLInputElement).value) {
        return (el as HTMLInputElement).value;
      }
    }

    const text = (el.textContent ?? '').trim();
    return text ? text.slice(0, 80) : undefined;
  }

  function cssPath(node: Element): string {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const testId = attr(node, 'data-testid') ?? attr(node, 'data-test') ?? attr(node, 'data-qa');
    if (testId) return `[data-testid="${testId}"]`;
    const parent = node.parentElement;
    if (!parent) return node.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    const nth = siblings.indexOf(node) + 1;
    const parentPath = parent === document.body ? 'body' : cssPath(parent);
    return `${parentPath} > ${node.tagName.toLowerCase()}:nth-of-type(${nth})`;
  }

  function bundle(el: Element): Record<string, unknown> {
    const tag = el.tagName.toLowerCase();
    const testId = attr(el, 'data-testid') ?? attr(el, 'data-test') ?? attr(el, 'data-qa');
    const id = el.id || undefined;
    const name = accessibleName(el);
    const placeholder = attr(el, 'placeholder');
    const inputType = tag === 'input' ? (attr(el, 'type') ?? 'text') : undefined;
    const text = (el.textContent ?? '').trim().slice(0, 80) || undefined;

    const out: Record<string, unknown> = { css: cssPath(el), tag, role: role(el) };
    if (name !== undefined) {
      out.name = name;
      out.label = name;
    }
    if (testId !== undefined) out.testId = testId;
    if (id !== undefined) out.id = id;
    if (placeholder !== undefined) out.placeholder = placeholder;
    if (inputType !== undefined) out.inputType = inputType;
    if (text !== undefined) out.text = text;
    return out;
  }

  function send(kind: string, el: Element, value: string | undefined, isPassword: boolean): void {
    w.__rastroCapture?.({ kind, bundle: bundle(el), value, isPassword, ts: Date.now() });
  }

  // A click on any of these fires its own `change` event too (a `check`/
  // `uncheck` action, or a text edit committed on blur); skipping the click
  // here avoids recording the same human gesture as two actions.
  const SKIP_CLICK_INPUT_TYPES = new Set(['text', 'password', 'email', 'search', 'number', 'checkbox', 'radio', 'file']);

  const onClick = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target) return;
    const tag = target.tagName.toLowerCase();
    if (tag === 'option' || tag === 'select') return;
    if (tag === 'input' && SKIP_CLICK_INPUT_TYPES.has((attr(target, 'type') ?? 'text').toLowerCase())) return;

    const isSubmitButton =
      (tag === 'button' && (attr(target, 'type') ?? 'submit').toLowerCase() === 'submit') ||
      (tag === 'input' && (attr(target, 'type') ?? '').toLowerCase() === 'submit');
    if (isSubmitButton) lastSubmitClick = { form: target.closest('form'), ts: Date.now() };

    send('click', target, undefined, false);
  };

  const onChange = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target) return;
    const tag = target.tagName.toLowerCase();

    if (tag === 'select') {
      const select = target as HTMLSelectElement;
      const option = select.options[select.selectedIndex];
      send('select', target, option ? option.text : select.value, false);
      return;
    }

    if (tag === 'input') {
      const input = target as HTMLInputElement;
      const type = (input.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        send(input.checked ? 'check' : 'uncheck', target, undefined, false);
        return;
      }
      if (type === 'file') {
        // A page never learns where a chosen file came from: `input.value` is
        // `C:\\fakepath\\<name>` everywhere, on purpose. Send the name so the
        // saved flow can say what was attached, and let the caller supply the
        // real path as a parameter at run time.
        const picked = input.files && input.files.length > 0 ? input.files[0]!.name : '';
        send('upload', target, picked, false);
        return;
      }
      const isPassword = type === 'password';
      send('fill', target, isPassword ? '•••' : input.value, isPassword);
      return;
    }

    if (tag === 'textarea') {
      send('fill', target, (target as HTMLTextAreaElement).value, false);
    }
  };

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    const target = e.target as Element | null;
    if (!target) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    send('press', target, 'Enter', false);
  };

  const onSubmit = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target) return;
    const now = Date.now();
    if (lastSubmitClick && lastSubmitClick.form === target && now - lastSubmitClick.ts < 300) return;
    send('submit', target, undefined, false);
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('submit', onSubmit, true);

  w.__rastroCaptureCleanup = () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('submit', onSubmit, true);
  };
}
