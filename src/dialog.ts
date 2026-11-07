// 通用确认/输入对话框（HTML 实现，风格统一）

export interface DialogOpts {
  message: string;
  okText?: string;
  danger?: boolean;
  input?: { initial: string; selectBaseName?: boolean };
}

export interface DialogResult {
  ok: boolean;
  value?: string;
}

const backdrop = () => document.getElementById("dialog-backdrop")!;
const msgEl = () => document.getElementById("dialog-msg")!;
const inputEl = () => document.getElementById("dialog-input") as HTMLInputElement;
const okBtn = () => document.getElementById("dialog-ok") as HTMLButtonElement;
const cancelBtn = () => document.getElementById("dialog-cancel") as HTMLButtonElement;

let active = false;
let resolver: ((r: DialogResult) => void) | null = null;

export function dialogOpen(): boolean {
  return active;
}

export function showDialog(opts: DialogOpts): Promise<DialogResult> {
  if (active) return Promise.resolve({ ok: false });
  active = true;
  resolver = null;

  msgEl().textContent = opts.message;
  const input = inputEl();
  const ok = okBtn();
  ok.textContent = opts.okText ?? "确定";
  ok.classList.toggle("danger", !!opts.danger);

  if (opts.input) {
    input.classList.remove("hidden");
    input.value = opts.input.initial;
  } else {
    input.classList.add("hidden");
    input.value = "";
  }

  backdrop().classList.remove("hidden");
  (opts.input ? input : ok).focus();
  if (opts.input?.selectBaseName) {
    // 选中主名（不含扩展名），便于快速改名
    const v = input.value;
    const dot = v.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : v.length);
  }

  return new Promise<DialogResult>((resolve) => {
    resolver = resolve;
  });
}

function finish(ok: boolean) {
  if (!active) return;
  active = false;
  backdrop().classList.add("hidden");
  const r = { ok, value: inputEl().value };
  resolver?.(r);
  resolver = null;
}

function onOk() { finish(true); }
function onCancel() { finish(false); }

okBtn().addEventListener("click", onOk);
cancelBtn().addEventListener("click", onCancel);
backdrop().addEventListener("mousedown", (e) => {
  if (e.target === backdrop()) onCancel();
});

document.addEventListener("keydown", (e) => {
  if (!active) return;
  e.stopPropagation(); // 阻止快捷键层收到对话框中的按键
  if (e.key === "Enter") {
    e.preventDefault();
    onOk();
  } else if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  }
}, true); // 捕获阶段，优先于全局快捷键
