/**
 * 跨组件共享的 IPC 载荷类型。
 *
 * 原先放在 `components/PinsPanel.tsx` 里,但那个组件从未被渲染(固定分组的
 * UI 已撤销),只被当成类型来源引用 —— 删组件时把类型挪到这里。
 */

export interface Pin {
  id: number;
  /** 1-based 行号 */
  line_no: number;
  group_id: number | null;
  /** 自定义名称(可空;侧栏以行号为主显示,名称是次级标签) */
  name: string;
  /** 组内排序序号(拖拽重排写入) */
  position: number;
  /** unix 秒 */
  created_at: number;
}

/** 分组:UI 已不再暴露,保留类型仅为兼容后端 list_pins 的返回结构 */
export interface PinGroup {
  id: number;
  name: string;
}
