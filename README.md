# ChatGPT LoopChat / ChatGPT 循环对话助手

English version below. 中文版本在下方。

---

## English

A Tampermonkey userscript for chatgpt.com designed for loop-based chat workflows: repeating prompts, continuing multi-round tasks, and keeping long conversations manageable in the browser.

> This project is a third-party userscript and is not affiliated with OpenAI. It is intended for browser-based repeat workflows and may need adjustments if ChatGPT changes its page structure or internal APIs.

### What it does

- Helps manage long chat sessions in the browser by reducing visible history and limiting unnecessary rendering work.
- Lets users define a list of prompts and run them in sequence for repeated multi-step or multi-round chat tasks.
- Keeps the workflow running from the web interface without repeatedly re-entering the same instructions manually.
- Shows a lightweight control panel for status tracking, stop/retry behavior, and repeated execution.
- Suitable for routine browser-based workflows that need multiple rounds of follow-up, iteration, or summarization.

### Typical use cases

- Repeated review or summarization of long chat history.
- Multi-step prompt loops that need to run in order across several rounds.
- Browser-based task loops for drafting, refinement, prioritization, and follow-up actions.
- Keeping a long conversation usable without manually resubmitting the same workflow repeatedly.

### Installation

1. Install Tampermonkey in your browser.
2. Create a new userscript and paste the full contents of [main.js](./main.js) into it.
3. Ensure the script header includes `@run-at document-start`.
4. Save the script and refresh any page under `https://chatgpt.com/*`.

The script currently includes GreasyFork update URLs. If you want to keep local changes without being overwritten by the online version, remove the `@downloadURL` and `@updateURL` lines from the header.

### Usage

#### Long Conversation Optimization

- Keep recent: number of the latest conversation items to keep visible.
- Hide after: when the total message count exceeds the threshold, older entries begin to be hidden or removed.
- Real DOM removal: when enabled, older nodes are removed instead of only hidden. Refreshing the page reloads the full history from the server.
- Live streaming / freeze active reply: controls rendering behavior while a response is generating.
- Click Apply to apply changes immediately.

#### Automatic Plan Loop

1. Set the number of rounds.
2. Add one prompt per line in the prompt list.
3. Click Start Plan.
4. During execution, the button changes to Stop Plan and the status bar shows the current phase and detection source.

The round count applies to the full prompt list. For example:

- 1 prompt repeated 3 times sends 3 requests
- 3 prompts repeated 3 times sends 9 requests

### How it works at a high level

The script is designed to support browser-side workflow automation without exposing the underlying implementation details. In practical terms, it:

- watches the current chat session state;
- keeps the interface responsive while conversation history grows;
- recognizes when a task has started and when a round has completed;
- continues prompting in sequence according to the configured loop.

This is intended for web-driven, repeatable workflows where a user wants to keep the browser session active and continue a series of related prompts without constant manual intervention.

### Privacy and Data Handling

- Configuration and runtime state are stored in the current site's `localStorage`.
- The script does not store access tokens, cookies, or chat content.
- It does not send data to a third-party server.
- The automatic plan sends prompts on behalf of the currently logged-in user.
- The script wraps the page's native `fetch` and only reads status signals for same-origin `conversation` and `lat/r` requests; it does not consume the raw response body.

### Known Limitations

- If ChatGPT changes its internal DOM structure, button labels, or API paths, the detection logic may need updating.
- Closing the tab or browser interrupts the current plan.
- Network issues, rate limiting, login expiration, or human verification may stop the plan and display a retry prompt.
- Enabling real DOM removal changes the current page structure; if rendering looks wrong, disable the option and refresh the page.

### Development and Validation

This project has no build step and no third-party dependencies. A Node.js 22 environment is sufficient for syntax validation:

```bash
node --check main.js
```

Project structure:

```text
.
├── main.js     # Tampermonkey userscript
├── README.md   # Project documentation
├── LICENSE     # MIT License
└── SDK/        # Supporting SDK assets
```

### License

This project is licensed under the [MIT License](./LICENSE).

---

## 中文

这是一个运行在 chatgpt.com 上的 Tampermonkey 用户脚本，面向“循环对话 / 多轮任务”场景，用于按提示词列表自动连续发送对话，并帮助管理长对话的浏览器体验。

> 本项目是第三方用户脚本，与 OpenAI 无官方关联。ChatGPT 的页面结构和内部接口可能会发生变化。

### 它解决什么问题

- 帮助在浏览器中处理超长对话，减少历史消息对页面性能的影响。
- 允许用户按照顺序定义一组提示词，并让它们自动循环执行，实现循环对话/任务推进。
- 让 Web 端的重复任务可以在同一会话中持续推进，而不是反复手动提交。
- 提供轻量状态面板，用来跟踪执行进度、停止和重试行为。
- 适合需要多轮重复思考、总结、改写和跟进的网页工作流场景。

### 主要使用场景

- 对长对话内容进行反复梳理和总结。
- 需要按顺序执行多步提示词的循环任务。
- 在 Web 端完成一组连续性的工作流，而无需手动反复输入。
- 让长会话保持更可控的状态，方便持续推进任务。

### 安装

1. 在浏览器中安装 Tampermonkey。
2. 新建用户脚本，并将 [main.js](./main.js) 的完整内容粘贴进去。
3. 确认脚本头中包含 `@run-at document-start`。
4. 保存脚本并刷新任意 `https://chatgpt.com/*` 页面。

当前脚本包含 GreasyFork 自动更新地址。如果想保留本地修改而不被在线版本覆盖，可以删除脚本头中的 `@downloadURL` 和 `@updateURL`。

### 使用方法

#### 长对话优化

- 保留最近：始终显示的最近对话数量。
- 超过开始处理：当对话数量超过该阈值后，旧消息将开始隐藏或移除。
- 真卸载 DOM：开启后会移除旧节点，而不只是隐藏。刷新页面后可重新加载完整历史。
- 实时流式渲染 / 冻结当前回复：控制回复生成时的页面渲染行为。
- 点击 立即应用 可直接应用更改。

#### 自动计划循环

1. 设置循环轮数。
2. 在提示词列表中每行填写一条提示词。
3. 点击 启动计划。
4. 执行期间，按钮会变成 停止计划，状态栏会显示当前阶段和检测来源。

循环轮数作用于整份提示词列表。例如：

- 1 条提示词循环 3 轮会发送 3 次请求
- 3 条提示词循环 3 轮会发送 9 次请求

### 高层工作原理

这个脚本的设计目标是让浏览器端的循环任务更加稳定和可控，而不是直接暴露所有内部实现细节。简而言之，它会：

- 观察当前会话状态；
- 维持长对话页面在可用范围内的响应性；
- 判断当前轮次是否已开始并完成；
- 按配置好的顺序继续提交下一条提示词。

它主要适用于 Web 端重复式、多轮连续执行的任务场景，例如需要在同一页面中逐轮推进一组相关动作的情况。

### 数据与隐私

- 配置和运行状态保存在当前站点的 `localStorage` 中。
- 脚本不会保存访问令牌、Cookie 或聊天内容。
- 脚本不会向第三方服务器发送数据。
- 自动计划会代表当前登录用户向 ChatGPT 发送配置好的提示词。
- 脚本会包装页面原生 `fetch`，只读取同源 `conversation` 和 `lat/r` 请求的状态信号，不消费原始响应正文。

### 已知限制

- 如果 ChatGPT 更新内部 DOM 结构、按钮文案或接口路径，检测逻辑可能需要同步更新。
- 关闭标签页或浏览器会中断当前计划。
- 网络异常、限流、登录失效或人工验证可能导致计划停止并显示重试提示。
- 开启“真卸载 DOM”会改变当前页面结构；如果显示异常，请关闭该选项并刷新页面。

### 开发与检查

该项目没有构建步骤，也没有第三方依赖。Node.js 22 环境即可进行语法检查：

```bash
node --check main.js
```

项目结构：

```text
.
├── main.js     # Tampermonkey 用户脚本
├── README.md   # 项目说明
├── LICENSE     # MIT License
└── SDK/        # 相关 SDK 资源
```

### License

本项目采用 [MIT License](./LICENSE)。
