---
description: "ChatHub 侧边栏面板：浏览器 provider、带检查点的模型切换与跨模型会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-chathub

[English](README.md) | 中文

## 概述

这个可选浏览器插件在侧边栏加入 ChatHub 入口及其打开的主面板。面板列出每个浏览器 provider 及其连接状态，创建绑定单一 provider 的会话，并展示打开会话的消息。切换会话模型走宿主的检查点交接流程，并把切换记录写入会话的 provider 历史。会话、消息与检查点存放在宿主的 storage domain，宿主重启后可恢复。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在宿主上启用 [chathub-host 的 bundle 行](../chathub-host/README.zh.md)，再打开侧边栏的 ChatHub 入口。面板通过 `chatHub` Remote 读取每个 provider 的身份与连接状态；需要登录的 provider 显示状态与登录动作，经 `webChat` Remote 打开站点的登录窗口。创建会话时填写标题、任务目标与起始 provider；会话打开后是空会话。输入消息并按 Enter 执行一轮：用户消息先落盘，当前 provider 作答，答案随轮次写入。失败的轮次保留用户消息，把会话标记为失败并返回稳定的 `provider: code` 错误，不写入 assistant 消息。

在打开的会话中用切换器更换模型。宿主先写检查点、编译规范上下文、渲染交接提示词，再把会话移交给目标 provider 等待下一轮；面板随后显示更新后的 provider 历史，即该会话用过的模型顺序。删除会话会从宿主 storage 中移除其消息、时间线与检查点。宿主重启后面板恢复所有已存会话及其持久化状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Maintainer details — click to expand</summary>

本包仅运行在浏览器：宿主入口是标记函数，client 入口先挂载生成的 `chathub-host` Remote，再注册面板与侧边栏贡献。注册时创建的单例 store 持有 provider 列表、会话列表、打开的会话与错误状态；注入的 face 把每个用户动作翻译成 `chatHub` 或 `webChat` Remote 调用，并把结果经 store action 写回。Remote 失败显示为错误行；宿主把所有失败归一化为稳定错误码，面板不会渲染站点原文。会话输入框采用乐观发送：用户消息立即渲染，失败轮次将其保留并置错误行。

</details>

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过面板调用的 `chatHub` Remote：它转发用户撰写的消息与本地化的切换原因，宿主控制器拥有编译上下文、渲染的交接提示词与页面分发。

#### KV Cache 影响

面板除用户输入与切换原因外不添加任何内容；缓存的请求前缀只在宿主的编译上下文跨轮变化时改变，例如目标被编辑或记录了一次模型切换。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 面板不消费流式输出：一轮在其 Remote 调用结束后整体渲染，长回答不会渐进显示。
- Provider 登录需要可见的浏览器窗口；headless 宿主无法完成交互式登录流程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
