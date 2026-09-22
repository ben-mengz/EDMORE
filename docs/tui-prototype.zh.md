# Terminal UI 第一版

2026-09-17

- 新增可选包 `client/packages/tui`，提供 Cordis apply/dispose 入口及独立终端启动入口。
- 不加入常驻后端 profile；界面通过现有 HTTP/SSE 接口连接后端，不创建第二套 agent loop。
- 支持历史对话显示、现有 conversation 切换、输入消息、显式 plan approve、Workflow 状态显示和历史滚动。
- 普通确认文本交给后端用户意图处理，不在客户端添加关键词路由。
- 退出只断开连接，不取消运行中的 workflow。
- 新增明确标注的只读 DEMO 模式用于 presentation，不连接模型或硬件。
- 验证：3 项 Node 测试通过；伪终端运行 DEMO 和实际后端连接成功，读到了已有 conversation、模型和工作流状态，退出正常。
- 没有在真实会话中提交消息、批准计划或操作硬件。真实写操作及断线恢复仍需要后续完整验收。
- 已打开 Terminal 演示窗口；自动 UI 工具拒绝访问 Terminal，未完成真实窗口截图检查。
- 第一版没有复用第三方 TUI 源码或增加依赖；后续可替换终端渲染层，保留 HTTP/SSE 边界。
