// 通用确认/输入对话框（HTML 实现，风格统一）
// 无障碍：role="dialog" aria-modal（见 index.html）、打开时聚焦首个控件、Tab 焦点陷阱、关闭后还原焦点

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
/** 打开对话框前的焦点元素，关闭后还原 */
let prevFocus: HTMLElement | null = null;

export function dialogOpen(): boolean {
  return active;
}

// ---------- 其他模态（导出/设置）与确认框的互斥 ----------

let modalCount = 0;

export function modalBegin() {
  modalCount++;
}

export function modalEnd() {
  modalCount = Math.max(0, modalCount - 1);
}

/** 任何模态打开时，全局快捷键都应让位 */
export function modalOpen(): boolean {
  return active || modalCount > 0;
}

export function showDialog(opts: DialogOpts): Promise<DialogResult> {
  if (active) return Promise.resolve({ ok: false });
  active = true;
  resolver = null;
  prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

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
  // 还原焦点（元素已不在文档中则忽略）
  if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  prevFocus = null;
}

function onOk() { finish(true); }
function onCancel() { finish(false); }

/** 对话框内当前可聚焦的控件（输入框隐藏时不含） */
function focusables(): HTMLElement[] {
  const list: HTMLElement[] = [];
  const input = inputEl();
  if (!input.classList.contains("hidden")) list.push(input);
  list.push(cancelBtn(), okBtn());
  return list;
}

okBtn().addEventListener("click", onOk);
cancelBtn().addEventListener("click", onCancel);
backdrop().addEventListener("mousedown", (e) => {
  if (e.target === backdrop()) onCancel();
});

document.addEventListener("keydown", (e) => {
  if (!active) return;
  e.stopPropagation(); // 阻止快捷键层收到对话框中的按键
  if (e.key === "Tab") {
    // 简单焦点陷阱：Tab 在对话框内循环
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    const cur = document.activeElement;
    if (!items.includes(cur as HTMLElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && cur === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault();
      first.focus();
    }
  } else if (e.key === "Enter") {
    // 焦点在按钮上时让按钮自己响应（例如"取消"上按 Enter 不应确认）
    if (document.activeElement instanceof HTMLButtonElement) return;
    e.preventDefault();
    onOk();
  } else if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  }
}, true); // 捕获阶段，优先于全局快捷键
