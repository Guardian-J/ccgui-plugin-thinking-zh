/**
 * 中文思考（thinking-zh）— CC GUI Tier-1 插件，单文件 ESM，无 import / 无 JSX。
 *
 * 为什么不是「翻译已生成的思考」：宿主的思考区（ThinkingSurface）按纯文本渲染，
 * 插件事件流（NormalizedRuntimeEvent）里没有思考增量，SDK 也不暴露会话消息内容，
 * 事后翻译没有可读的数据源。宿主受支持的通道是 beforeTurn 的 promptContribution：
 * 把一条 visibility=internal 的指令追加在请求尾部的内部段，要求引擎直接用中文
 * 书写 thinking / reasoning。宿主会自动隐藏这段文本，不进入可见对话，并在插件
 * 停止贡献后补发一次撤回通知。
 *
 * 0.2.0 起增加系统级注入（0.2.1 起默认开启，可在设置里关闭）：DeepSeek 等模型
 * 服从尾部指令，但 Claude 会把它
 * 当成提示注入而拒绝（实测原话「我无法控制内部推理的呈现格式」），GPT 的推理
 * 文本宿主持不到。宿主把所有贡献一律拼进 user 消息（engine/mod.rs 的
 * effective_prompt），插件无法直接改 system prompt；唯一不改宿主代码的做法是
 * 写引擎自己的全局记忆文件（~/.omp/agent/AGENTS.md、~/.claude/CLAUDE.md、
 * ~/.codex/AGENTS.md），这些文件进系统提示。插件用标记段维护，关闭即移除。
 */

const LANGUAGES = {
  "zh-CN": {
    label: "简体中文",
    instruction:
      "【思考语言 · 硬性约束】thinking / reasoning 通道里的每一个字都必须使用简体中文——包括工具调用前的规划、试错与自我检查。只约束思考通道，与最终回复语言无关；代码、命令、路径、标识符保持原文。\n" +
      "THINKING LANGUAGE OVERRIDE (highest priority): every token of your reasoning channel MUST be Simplified Chinese from this turn on — including tool planning, retries and self-checks. This overrides the language of earlier turns in this session; do not mirror their English reasoning. The final answer language is unaffected.",
    memory:
      "思考语言：每一条内部推理（thinking / reasoning）都必须使用简体中文书写，包括工具调用前的规划、试错与自我检查；代码、命令、路径、标识符保持原文。这条只约束内部推理，不影响最终回复语言。",
  },
  "zh-TW": {
    label: "繁體中文",
    instruction:
      "【思考語言 · 硬性約束】thinking / reasoning 通道裡的每一個字都必須使用繁體中文——包含工具呼叫前的規劃、試錯與自我檢查。只約束思考通道，與最終回覆語言無關；程式碼、指令、路徑、識別符保持原文。\n" +
      "THINKING LANGUAGE OVERRIDE (highest priority): every token of your reasoning channel MUST be Traditional Chinese (繁體中文) from this turn on — including tool planning, retries and self-checks. This overrides the language of earlier turns in this session; do not mirror their English reasoning. The final answer language is unaffected.",
    memory:
      "思考語言：每一條內部推理（thinking / reasoning）都必須使用繁體中文書寫，包含工具呼叫前的規劃、試錯與自我檢查；程式碼、指令、路徑、識別符保持原文。這條只約束內部推理，不影響最終回覆語言。",
  },
};

const DEFAULTS = { enabled: true, language: "zh-CN", extra: "", mode: "session", systemLevel: true };
const STORAGE_KEY = "settings";
const CONTRIBUTION_ID = "thinking-zh:instruction";
const MAX_EXTRA = 2000;

// 系统级注入：宿主把所有 promptContribution 一律拼进 user 消息
// （engine/mod.rs:106 的 effective_prompt），Claude / GPT 会把它当成提示注入而
// 拒绝服从——实测 Claude 直接回绝不会照做，同一句话写进引擎的全局记忆文件
// （系统提示）才生效。插件自己维护带标记的段落，不改宿主代码。
const SYSTEM_TARGETS = [".omp/agent/AGENTS.md", ".claude/CLAUDE.md", ".codex/AGENTS.md"];
const SYSTEM_MARK_BEGIN = "<!-- thinking-zh:begin -->";
const SYSTEM_MARK_END = "<!-- thinking-zh:end -->";

// 由 node 执行：mode=on 时写入/替换标记段，mode=off 时只移除。参数依次是
// mode、正文、若干相对用户目录的路径；stdout 输出每个文件的处理结果。
const EXEC_SCRIPT = String.raw`const fs=require("fs"),os=require("os"),path=require("path");
const B="<!-- thinking-zh:begin -->",E="<!-- thinking-zh:end -->";
const argv=process.argv.slice(1),start=argv[0]==="on"||argv[0]==="off"?0:1,mode=argv[start]==="on"?"on":"off",text=argv[start+1]||"",targets=argv.slice(start+2);
function clean(cur){
  let out=cur,found=false;
  for(;;){
    const i=out.indexOf(B);
    if(i<0)break;
    const j=out.indexOf(E,i);
    out=j<0?out.slice(0,i):out.slice(0,i)+out.slice(j+E.length);
    found=true;
  }
  if(found)out=out.replace(/\n{3,}/g,"\n\n");
  return out.replace(/\s+$/,"");
}
const done=[];
for(const rel of targets){
  const file=path.join(os.homedir(),rel);
  let cur="";
  try{cur=fs.readFileSync(file,"utf8");}catch(error){if(error.code!=="ENOENT"){done.push({path:file,error:String(error.message||error)});continue;}}
  const base=clean(cur);
  const next=mode==="on"?(base?base+"\n\n":"")+B+"\n"+text+"\n"+E+"\n":(base?base+"\n":"");
  if(mode==="off"&&next===""&&cur!==""){
    try{fs.unlinkSync(file);}catch(error){done.push({path:file,error:String(error.message||error)});continue;}
    done.push({path:file,changed:true,removed:true});
    continue;
  }
  if(next!==cur){
    try{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+".thinking-zh.tmp";fs.writeFileSync(tmp,next,"utf8");fs.renameSync(tmp,file);}catch(error){done.push({path:file,error:String(error.message||error)});continue;}
  }
  done.push({path:file,changed:next!==cur});
}
process.stdout.write(JSON.stringify(done));`;

export default function activate(ctx) {
  const { createElement: h, useEffect, useRef, useState } = ctx.react;

  let settings = { ...DEFAULTS };
  let loaded = false;
  let touched = false;
  let revision = 0;
  let acceptedCount = 0;
  let lastAcceptedAt = 0;
  let saveTimer = null;
  // 系统级注入的运行状态：idle / pending / ok / partial / error / unsupported。
  let systemState = { status: "idle", mode: "", language: "", files: [], error: "", at: 0 };
  const listeners = new Set();

  function normalize(raw) {
    const next = { ...DEFAULTS };
    if (!raw || typeof raw !== "object") return next;
    if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
    if (typeof raw.language === "string" && LANGUAGES[raw.language]) next.language = raw.language;
    if (raw.mode === "turn" || raw.mode === "session") next.mode = raw.mode;
    if (typeof raw.systemLevel === "boolean") next.systemLevel = raw.systemLevel;
    if (typeof raw.extra === "string") next.extra = raw.extra.slice(0, MAX_EXTRA);
    return next;
  }

  function notify() {
    revision += 1;
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        console.error("[thinking-zh] 订阅回调失败", error);
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return ctx.storage.set(STORAGE_KEY, { ...settings }).catch((error) => {
      console.error("[thinking-zh] 保存设置失败", error);
    });
  }

  function update(patch) {
    touched = true;
    settings = { ...settings, ...patch };
    notify();
    void save();
    syncAfterChange();
  }

  const loadPromise = (async () => {
    try {
      const stored = await ctx.storage.get(STORAGE_KEY);
      if (!touched) settings = normalize(stored);
    } catch (error) {
      console.error("[thinking-zh] 读取设置失败", error);
    } finally {
      loaded = true;
      notify();
    }
  })();

  function isActive() {
    return settings.enabled;
  }

  function instructionText(extraText) {
    const language = LANGUAGES[settings.language] ?? LANGUAGES["zh-CN"];
    const extra = (extraText ?? settings.extra).trim();
    return extra ? `${language.instruction}\n${extra}` : language.instruction;
  }

  function memoryInstruction() {
    const language = LANGUAGES[settings.language] ?? LANGUAGES["zh-CN"];
    return language.memory;
  }

  function desiredSystemMode() {
    return settings.systemLevel && settings.enabled ? "on" : "off";
  }

  async function syncSystemLevel(mode) {
    const bridge = ctx.bridge;
    if (!bridge || typeof bridge.invoke !== "function") {
      systemState = { status: "unsupported", mode, language: settings.language, files: [], error: "", at: Date.now() };
      notify();
      return;
    }
    systemState = { ...systemState, status: "pending", mode, language: settings.language, error: "" };
    notify();
    try {
      const result = await bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: ["-e", EXEC_SCRIPT, mode, memoryInstruction()].concat(SYSTEM_TARGETS),
        timeoutMs: 15000,
      });
      if (!result || result.code !== 0) {
        const detail = String((result && (result.stderr || result.stdout)) || "").trim();
        throw new Error(detail || `node 退出码 ${result ? result.code : "未知"}`);
      }
      const files = JSON.parse(result.stdout || "[]");
      const failed = files.filter((item) => item && item.error);
      systemState = {
        status: failed.length ? "partial" : "ok",
        mode,
        language: settings.language,
        files,
        error: failed.map((item) => `${item.path}：${item.error}`).join("；"),
        at: Date.now(),
      };
    } catch (error) {
      systemState = {
        status: "error",
        mode,
        language: settings.language,
        files: systemState.files,
        error: String((error && error.message) || error),
        at: Date.now(),
      };
    }
    notify();
  }

  // 只在目标状态与已应用状态不一致时才落盘，避免每次改字都起一个 node。
  function syncAfterChange() {
    if (!ctx.bridge || typeof ctx.bridge.invoke !== "function") return;
    const want = desiredSystemMode();
    if (want === "off" && systemState.status === "idle") return;
    if (systemState.mode === want && systemState.language === settings.language) return;
    void syncSystemLevel(want);
  }

  // 启动时若已开启系统级注入，补写一次（文件被外部删掉也能恢复）。
  void loadPromise.then(() => {
    if (desiredSystemMode() === "on" && systemState.status === "idle") void syncSystemLevel("on");
  });

  // 每轮发送前由宿主收集：只在开启时贡献，关闭后宿主自动补一条撤回通知。
  ctx.hooks.registerTurnHooks({
    beforeTurn() {
      if (!isActive()) return;
      return {
        promptContributions: [
          {
            id: CONTRIBUTION_ID,
            content: instructionText(),
            placement: "system-tail",
            visibility: "internal",
            persistence: settings.mode === "turn" ? "turn" : "session",
            onAccepted: () => {
              acceptedCount += 1;
              lastAcceptedAt = Date.now();
              notify();
            },
          },
        ],
        isCurrent: () => isActive(),
      };
    },
  });

  function useSettingsState() {
    const [snap, setSnap] = useState({ revision });
    const [isReady, setReady] = useState(loaded);
    useEffect(() => {
      const unsubscribe = subscribe(() => {
        setSnap({ revision });
        if (loaded) setReady(true);
      });
      void loadPromise.then(() => {
        setSnap({ revision });
        setReady(true);
      });
      return unsubscribe;
    }, []);
    return { value: settings, ready: isReady };
  }

  const inputStyle = {
    borderRadius: 8,
    border: "1px solid var(--color-border-button-default)",
    background: "var(--color-background-primary-default)",
    color: "var(--color-text-primary)",
    padding: "6px 8px",
    fontSize: 12,
    fontFamily: "inherit",
    boxSizing: "border-box",
    width: "100%",
  };
  const hintStyle = {
    fontSize: 11,
    lineHeight: 1.5,
    color: "var(--color-text-tertiary)",
  };

  function systemStatusText(value) {
    if (!value.systemLevel) return "未启用：只注入请求尾部，Claude / GPT 通常不服从。";
    switch (systemState.status) {
      case "pending":
        return "正在写入…";
      case "ok": {
        const files = systemState.files || [];
        const written = files.filter((item) => item && item.changed).length;
        return `已同步 ${files.length} 个文件，其中 ${written} 个有改动（${new Date(systemState.at).toLocaleTimeString()}）。`;
      }
      case "partial":
      case "error":
        return `写入失败：${systemState.error}`;
      case "unsupported":
        return "宿主未提供 bridge，无法写入文件。";
      default:
        return "等待写入…";
    }
  }

  function StatusChip() {
    const { value } = useSettingsState();
    const on = value.enabled;
    return h(
      "button",
      {
        type: "button",
        "aria-pressed": on,
        title: on ? "模型的思考过程使用中文（点击关闭）" : "点击让模型的思考过程使用中文",
        onClick: () => update({ enabled: !settings.enabled }),
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 22,
          padding: "0 9px",
          borderRadius: 999,
          border: "1px solid var(--color-border-button-default)",
          background: "transparent",
          color: on ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
          fontFamily: "inherit",
          fontSize: 11,
          lineHeight: 1,
          cursor: "pointer",
          whiteSpace: "nowrap",
        },
      },
      h("span", {
        key: "dot",
        "aria-hidden": true,
        style: {
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: on ? "var(--color-accent-500)" : "var(--color-text-tertiary)",
        },
      }),
      h("span", { key: "label" }, on ? "中文思考" : "中文思考 · 关"),
    );
  }

  function SettingsSection() {
    const { value, ready: isReady } = useSettingsState();
    const [extra, setExtra] = useState(value.extra);
    const extraEditing = useRef(false);
    const extraTimer = useRef(null);

    useEffect(() => {
      if (!extraEditing.current) setExtra(value.extra);
    }, [value.extra]);

    useEffect(
      () => () => {
        clearTimeout(extraTimer.current);
        extraTimer.current = null;
      },
      [],
    );

    if (!isReady) {
      return h(
        "div",
        { style: { padding: "12px 0", fontSize: 12, color: "var(--color-text-tertiary)" } },
        "正在读取设置…",
      );
    }

    const commitExtra = (next) => {
      extraEditing.current = false;
      update({ extra: next });
    };
    const scheduleExtra = (next) => {
      clearTimeout(extraTimer.current);
      extraTimer.current = setTimeout(() => {
        extraTimer.current = null;
        commitExtra(next);
      }, 600);
    };

    const cardStyle = {
      border: "1px solid var(--color-border-button-default)",
      borderRadius: 10,
      padding: "12px 14px",
      display: "grid",
      gap: 14,
    };
    const fieldStyle = { display: "grid", gap: 6 };
    const fieldLabelStyle = { fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)" };
    const preview = `[CCGUI internal system-tail]\n${instructionText(extra)}`;

    return h(
      "div",
      { style: { display: "grid", gap: 16, padding: "4px 0 8px" } },
      h(
        "div",
        { style: { display: "grid", gap: 4 } },
        h(
          "div",
          { style: { fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" } },
          "中文思考",
        ),
        h(
          "div",
          { style: hintStyle },
          "向每一轮请求追加一条隐藏指令，要求引擎用中文书写 thinking / reasoning。只影响思考过程，不改变最终回复语言；指令不会出现在可见对话里。会话此前一直用英文思考时，指令里的英文 override 段会要求模型从本轮起切换。Claude / GPT 会把这类尾部指令当成提示注入而拒绝，需要在下方开启系统级注入。",
        ),
      ),
      h(
        "div",
        { style: cardStyle },
        h(
          "label",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--color-text-primary)",
              cursor: "pointer",
            },
          },
          h("input", {
            type: "checkbox",
            checked: value.enabled,
            onChange: (event) => update({ enabled: event.target.checked }),
          }),
          h("span", null, "启用（每轮自动注入）"),
        ),
        h(
          "label",
          { style: fieldStyle },
          h("span", { style: fieldLabelStyle }, "思考语言"),
          h(
            "select",
            {
              value: value.language,
              disabled: !value.enabled,
              onChange: (event) => update({ language: event.target.value }),
              style: inputStyle,
            },
            Object.keys(LANGUAGES).map((key) =>
              h("option", { key, value: key }, LANGUAGES[key].label),
            ),
          ),
        ),
        h(
          "label",
          { style: fieldStyle },
          h("span", { style: fieldLabelStyle }, "附加要求（可选）"),
          h("textarea", {
            value: extra,
            disabled: !value.enabled,
            rows: 3,
            maxLength: MAX_EXTRA,
            placeholder: "例如：数学推导保留公式符号；思考中的文件路径保持原样。",
            onChange: (event) => {
              const next = event.target.value;
              extraEditing.current = true;
              setExtra(next);
              scheduleExtra(next);
            },
            onBlur: () => {
              clearTimeout(extraTimer.current);
              extraTimer.current = null;
              if (extraEditing.current) commitExtra(extra);
            },
            style: { ...inputStyle, resize: "vertical", minHeight: 64, lineHeight: 1.5 },
          }),
          h("span", { style: hintStyle }, "追加在默认指令之后，随思考语言一起注入。"),
        ),
        h(
          "label",
          { style: fieldStyle },
          h("span", { style: fieldLabelStyle }, "注入范围"),
          h(
            "select",
            {
              value: value.mode,
              disabled: !value.enabled,
              onChange: (event) => update({ mode: event.target.value }),
              style: inputStyle,
            },
            h("option", { value: "session" }, "整个会话（宿主记住，后续轮次自动携带）"),
            h("option", { value: "turn" }, "仅当前轮"),
          ),
          h(
            "span",
            { style: hintStyle },
            value.mode === "session"
              ? "关闭开关后，宿主会在下一轮请求里附一条撤回通知，之后不再注入。"
              : "每轮都按开关重新决定是否注入，不写进会话历史。",
          ),
        ),
      ),
      h(
        "div",
        { style: cardStyle },
        h(
          "div",
          { style: { ...fieldLabelStyle, display: "flex", alignItems: "center", gap: 8 } },
          "系统级注入（Claude / GPT 必需）",
        ),
        h(
          "div",
          { style: hintStyle },
          "Claude 会把请求尾部的指令当成提示注入而拒绝服从（实测原话：“我无法控制内部推理的呈现格式”）；同一句话只有进入引擎的全局记忆文件、也就是系统提示，才会生效。开启后插件维护带标记的段落，关闭或停用插件即移除。",
        ),
        h(
          "label",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--color-text-primary)",
              cursor: "pointer",
            },
          },
          h("input", {
            type: "checkbox",
            checked: value.systemLevel,
            onChange: (event) => update({ systemLevel: event.target.checked }),
          }),
          h("span", null, "写入引擎全局记忆文件"),
        ),
        h(
          "div",
          { style: hintStyle },
          `目标文件（相对用户目录，不存在则创建）：${SYSTEM_TARGETS.join("、")}`,
        ),
        h("div", { style: hintStyle }, systemStatusText(value)),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12 } },
          h(
            "button",
            {
              type: "button",
              disabled: systemState.status === "pending",
              onClick: () => void syncSystemLevel(desiredSystemMode()),
              style: {
                borderRadius: 8,
                border: "1px solid var(--color-border-button-default)",
                background: "transparent",
                color: "var(--color-text-primary)",
                padding: "5px 10px",
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
              },
            },
            "立即同步",
          ),
          h("span", { style: hintStyle }, "改完语言后点一次即可重写。"),
        ),
      ),
      h(
        "div",
        { style: { display: "grid", gap: 6 } },
        h("div", { style: fieldLabelStyle }, "注入内容预览"),
        h(
          "div",
          { style: hintStyle },
          value.enabled ? "下一轮请求尾部实际追加的内部段：" : "当前已关闭，不会追加任何内容。",
        ),
        h(
          "div",
          { style: hintStyle },
          acceptedCount === 0
            ? "宿主尚未确认注入：发送一轮对话后这里会更新。"
            : `宿主已确认注入 ${acceptedCount} 次（最近 ${new Date(lastAcceptedAt).toLocaleTimeString()}）。`,
        ),
        h(
          "pre",
          {
            style: {
              margin: 0,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--color-border-button-default)",
              background: "var(--color-background-secondary-default)",
              color: value.enabled ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
              fontSize: 11,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
            },
          },
          preview,
        ),
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 12 } },
        h(
          "button",
          {
            type: "button",
            onClick: () => {
              extraEditing.current = false;
              clearTimeout(extraTimer.current);
              extraTimer.current = null;
              setExtra(DEFAULTS.extra);
              update({ ...DEFAULTS });
            },
            style: {
              borderRadius: 8,
              border: "1px solid var(--color-border-button-default)",
              background: "transparent",
              color: "var(--color-text-primary)",
              padding: "5px 10px",
              fontSize: 12,
              fontFamily: "inherit",
              cursor: "pointer",
            },
          },
          "恢复默认",
        ),
        h("span", { style: hintStyle }, "改动即时保存，下一轮发送生效。"),
      ),
    );
  }

  ctx.ui.registerSettingsSection({
    key: "settings",
    label: () => "中文思考",
    component: SettingsSection,
  });

  ctx.ui.registerStatusBarItem({
    key: "thinking-zh-toggle",
    component: StatusChip,
    order: 50,
    zone: "end",
  });

  ctx.ui.registerCommand({
    key: "thinking-zh.toggle",
    title: () => (settings.enabled ? "中文思考：关闭" : "中文思考：开启"),
    keywords: () => ["thinking", "reasoning", "思考", "中文"],
    run: () => update({ enabled: !settings.enabled }),
  });

  ctx.ui.registerCommand({
    key: "thinking-zh.settings",
    title: () => "中文思考：打开设置",
    keywords: () => ["thinking", "reasoning", "思考", "设置"],
    run: () => ctx.ui.openSettings("settings"),
  });

  return () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    listeners.clear();
  };
}
