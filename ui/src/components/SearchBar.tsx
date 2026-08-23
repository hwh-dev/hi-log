import { useMemo, useRef, useState, type Ref } from "react";
import {
  getSettings,
  loadSearchHistory,
  recordSearchHistory,
  clearSearchHistory,
} from "../utils/settings";

interface Props {
  query: string;
  setQuery: (v: string) => void;
  regex: boolean;
  setRegex: (v: boolean) => void;
  caseSensitive: boolean;
  setCaseSensitive: (v: boolean) => void;
  running: boolean;
  /** 手动触发搜索(回车或点 Search) */
  onSearch: () => void;
  onStop: () => void;
  hitCount: number;
  truncated: boolean;
  progress: { scanned: number; total: number } | null;
  /** 命中面板是否可见;点击切换折叠/展开(弹出窗口打开时点击收回) */
  filterVisible: boolean;
  onToggleFilter: () => void;
  /** 按给定词立即搜索(历史点击/上下键选择时用当前选项) */
  onApplyQuery: (q: string, regex: boolean, caseSensitive: boolean) => void;
  /** 外部聚焦引用(快捷键 Ctrl+F 聚焦搜索栏) */
  inputRef?: Ref<HTMLInputElement>;
}

/** 命中部分高亮(前缀或包含匹配) */
function HighlightMatch({ text, match }: { text: string; match: string }) {
  if (!match.trim()) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(match.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="suggest-mark">{text.slice(idx, idx + match.length)}</mark>
      {text.slice(idx + match.length)}
    </>
  );
}

/**
 * 底部搜索栏(klogg 风格):输入框右侧 ▼ 展开历史,打字时自动联想;
 * ↑↓ 边移动边把历史词填入输入框(所见即所得),Enter 即搜。
 */
export default function SearchBar({
  query,
  setQuery,
  regex,
  setRegex,
  caseSensitive,
  setCaseSensitive,
  running,
  onSearch,
  onStop,
  hitCount,
  truncated,
  progress,
  filterVisible,
  onToggleFilter,
  onApplyQuery,
  inputRef,
}: Props) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.scanned / progress.total) * 100)
    : 0;

  // ── 搜索历史(localStorage 持久化,最近在前,去重;仅存查询词)──
  const [history, setHistory] = useState<string[]>(loadSearchHistory);
  const [suggestOpen, setSuggestOpen] = useState(false);
  /** 高亮索引;-1 = 无高亮(输入框保持用户文本) */
  const [hi, setHi] = useState(-1);
  /** 用户真实键入的原文(浏览前文本),Esc / 回到 -1 时还原 */
  const [userText, setUserText] = useState("");
  /**
   * 浏览模式:↑↓/悬停浏览期间列表固定为快照,避免"改写 query → 过滤重算 →
   * 列表抖动";真实键入退出浏览,列表恢复实时过滤。
   */
  const [browsing, setBrowsing] = useState(false);
  const browseRef = useRef<string[]>([]);

  // 记录一次搜索:新词插入最前,已有词置顶;上限走设置(searchHistoryMax)
  const recordHistory = (q: string) => {
    if (!q.trim()) return;
    setHistory(recordSearchHistory(q, getSettings().searchHistoryMax));
  };

  // 实时候选:输入非空 → 前缀匹配优先、其次包含;空输入 → 全部历史
  const filtered = useMemo(() => {
    const ql = query.trim().toLowerCase();
    if (!ql) return history;
    const prefix: string[] = [];
    const contains: string[] = [];
    for (const h of history) {
      const hl = h.toLowerCase();
      if (hl.startsWith(ql)) prefix.push(h);
      else if (hl.includes(ql)) contains.push(h);
    }
    return [...prefix, ...contains];
  }, [query, history]);

  /** 实际展示的列表:浏览期间用快照,否则实时过滤 */
  const list = browsing ? browseRef.current : filtered;
  const suggest = suggestOpen && list.length > 0;

  /** 进入浏览模式并固定当前列表为快照 */
  const startBrowse = (items: string[]) => {
    browseRef.current = items;
    setBrowsing(true);
    setSuggestOpen(true);
  };

  /** 移动高亮;输入框保持用户原文,只有 Enter 确定才用历史词(避免未确认时误改) */
  const moveHi = (next: number) => {
    if (next === -1) {
      setHi(-1);
      setQuery(userText);
    } else if (list[next]) {
      setHi(next);
    }
  };

  /** 选中一项:填入 + 记录 + 立即搜索(选项保持当前状态,不复原历史选项) */
  const pickAndSearch = (q: string) => {
    setQuery(q);
    setSuggestOpen(false);
    setBrowsing(false);
    recordHistory(q);
    onApplyQuery(q, regex, caseSensitive);
  };

  return (
    <div className="searchbar">
      <span className="search-icon" aria-hidden>🔍</span>
      <div className="search-input-wrap">
        <input
          className="search-input"
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setUserText(e.target.value);
            setHi(-1);
            setBrowsing(false); // 真实键入:退出浏览,回到实时过滤
            setQuery(e.target.value);
            // 打字即弹联想;清空输入自动收起
            setSuggestOpen(e.target.value.trim().length > 0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!suggestOpen) {
                // 打开列表:↓ 从顶部第一项开始顺走
                startBrowse(query.trim() ? filtered : history);
                moveHi(0);
              } else {
                moveHi(Math.min(hi + 1, list.length - 1));
              }
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (!suggestOpen) {
                // 打开列表:↑ 从贴输入框(最近历史)开始,向上翻 — 符合直觉
                startBrowse(query.trim() ? filtered : history);
                moveHi(list.length - 1);
              } else {
                moveHi(Math.max(hi - 1, -1));
              }
            } else if (e.key === "Escape") {
              setSuggestOpen(false);
              setBrowsing(false);
              setHi(-1);
              setQuery(userText);
            } else if (e.key === "Enter") {
              // 有高亮的历史项(悬停/↑↓ 选中)且列表开着 → 带上该词搜索;
              // 否则搜当前输入。不依赖 browsing 状态,避免悬停态时序丢失。
              if (suggestOpen && hi >= 0 && list[hi]) {
                pickAndSearch(list[hi]);
              } else {
                recordHistory(query);
                setSuggestOpen(false);
                setBrowsing(false);
                onSearch();
              }
            }
          }}
          placeholder="检索…(Enter 搜索,↑↓ 选历史)"
          spellCheck={false}
        />
        <button
          className={`search-drop ${suggestOpen ? "active" : ""}`}
          title={suggestOpen ? "收起历史" : "搜索历史"}
          onMouseDown={(e) => e.preventDefault()} // 保持输入框焦点
          onClick={() => {
            if (suggestOpen) {
              setSuggestOpen(false);
              setBrowsing(false);
              setHi(-1);
            } else {
              startBrowse(history); // ▼ 始终展开全部历史(与 klogg 一致)
            }
          }}
        >
          ▼
        </button>
        {suggest && (
          <div
            className="search-suggest"
            onMouseDown={(e) => e.preventDefault()}
          >
            {list.map((h, i) => (
              <div
                key={h}
                className={`suggest-item ${i === hi ? "active" : ""}`}
                onMouseEnter={() => {
                  // 悬停视作浏览:Enter 才带上该历史词;输入框保持原文
                  if (!browsing) {
                    browseRef.current = list;
                    setBrowsing(true);
                  }
                  setHi(i);
                }}
                onMouseDown={() => pickAndSearch(h)}
              >
                <span className="suggest-q">
                  <HighlightMatch text={h} match={browsing ? "" : query} />
                </span>
              </div>
            ))}
            <div
              className="suggest-clear"
              onMouseDown={() => {
                setHistory([]);
                clearSearchHistory();
                setSuggestOpen(false);
                setBrowsing(false);
              }}
            >
              清除历史
            </div>
          </div>
        )}
      </div>
      <button
        className={`toggle ${regex ? "active" : ""}`}
        title="正则表达式"
        onClick={() => setRegex(!regex)}
      >
        .*
      </button>
      <button
        className={`toggle ${caseSensitive ? "active" : ""}`}
        title="区分大小写"
        onClick={() => setCaseSensitive(!caseSensitive)}
      >
        Aa
      </button>

      {running ? (
        <>
          <span className="search-progress">{pct}%</span>
          <button className="stop-btn" onClick={onStop}>停止</button>
        </>
      ) : (
        <>
          <button
            className="search-go"
            onClick={() => {
              recordHistory(query);
              setSuggestOpen(false);
              setBrowsing(false);
              onSearch();
            }}
          >
            Search
          </button>
          {hitCount > 0 && (
            <>
              <span className="hit-count">
                {hitCount.toLocaleString()}
                {truncated ? "+" : ""} 命中
              </span>
              <button
                className="toggle filter-toggle"
                title={filterVisible ? "收起命中面板" : "展开命中面板"}
                onClick={onToggleFilter}
              >
                {filterVisible ? "▾" : "▸"} 面板
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
