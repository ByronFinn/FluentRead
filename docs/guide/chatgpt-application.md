---
title: 维护者申请 ChatGPT 接入
---

# 维护者申请 ChatGPT 接入

**截至 2026-10-14 核对时，流畅阅读尚未提交申请或获得公共接入批准，托管后端也未部署。** 本页面向维护者；普通用户请查看 [ChatGPT 套餐接入状态](/config/chatgpt-plan)。以下入口、字段和规则均为该日期的记录。

## 1. 打开官方意向表

打开 OpenAI 的 [Request a client ID](https://developers.openai.com/siwc/request-client-id)，点击 **Sign in with ChatGPT interest form**，或直接打开 [中文表单](https://openai.com/zh-Hans-CN/form/sign-in-with-chatgpt-interest/) / [英文表单](https://openai.com/form/sign-in-with-chatgpt-interest/)。填写意向表不会立即获得 client ID。

<img src="/guides/chatgpt-application/01-request-client-id.jpg" alt="OpenAI 官方页面中的接入意向表链接" width="1280" height="720" loading="lazy" />

截图：[OpenAI Developers](https://developers.openai.com/siwc/request-client-id)，2026-10-14，真实页面，未经改写。

核对时，官方将入口描述为面向选定商业合作伙伴的有限试用，并将开源开发者引向开发文档。个人维护者可如实介绍项目，但没有获准承诺或公开审核时限。已有 OpenAI 对接代表时，可按 [网站接入指南](https://developers.openai.com/siwc/website) 联系对方。

流畅阅读申请的是公众在扩展内使用 ChatGPT 套餐的流程。[开源套餐文档](https://developers.openai.com/siwc/token-sharing-open-source) 要求付费或远程托管应用通过意向表申请；开源身份本身不授予公共托管权限。

<img src="/guides/chatgpt-application/02-interest-form-top.jpg" alt="中文意向表的商业合作伙伴与开源开发者说明" width="1280" height="720" loading="lazy" />

截图：[OpenAI 中文意向表](https://openai.com/zh-Hans-CN/form/sign-in-with-chatgpt-interest/)，2026-10-14，字段未填，未提交。

## 2. 填写项目资料

以下为核对时的 8 个字段，星号表示必填。按真实情况调整，不虚构公司或身份。

| 字段 | 填写内容 |
| --- | --- |
| 工作邮箱 * | 可接收审核回复的真实邮箱 |
| 姓氏 * | 维护者本人的姓氏 |
| 名字 * | 维护者本人的名字 |
| 公司名称 * | 真实公司；个人项目可如实说明 `Independent open-source developer / FluentRead project`，此写法不保证资格 |
| 网站 URL * | `https://read.thinkstu.com/`，在产品介绍中补充仓库地址 |
| 职位 | 按实际填写，例如 `Open-source maintainer`；可选 |
| 希望实现的功能 * | 第二项：**登录并使用 ChatGPT 套餐发起 AI 请求** |
| 将接入的产品介绍 * | 项目功能、开源属性、扩展场景和计划中的托管流程，可参考下一节 |

<img src="/guides/chatgpt-application/03-interest-form-fields.jpg" alt="中文意向表中的个人、项目与功能字段" width="1280" height="720" loading="lazy" />

截图：[OpenAI 中文意向表](https://openai.com/zh-Hans-CN/form/sign-in-with-chatgpt-interest/)，2026-10-14，字段未填，未提交。

仅申请身份登录不能用于套餐 AI 请求。[官方 quickstart](https://developers.openai.com/siwc/quickstart) 将两项能力区分开；用户也须符合账户资格并授权套餐使用。

## 3. 产品介绍英文草稿

复制前核对实际项目状态。这份草稿说明申请目标，不声称已获批准或已经部署后端。

```text
FluentRead is an open-source browser extension for bilingual webpage translation, reading assistance, and writing. We would like eligible users to sign in with ChatGPT and authorize ChatGPT plan usage for these AI features.

Our intended public experience is sign-in and automatic return to the extension, without asking users to install a local runtime or perform developer setup. We are requesting approval for a hosted backend to manage the approved authentication and inference flow. This backend is planned and is not currently deployed.

Please confirm the supported client type, registered callback requirements, ChatGPT plan usage permissions, and whether this hosted browser-extension integration is eligible.

Project: https://github.com/FluentRead/FluentRead
Website: https://read.thinkstu.com/
```

<img src="/guides/chatgpt-application/04-interest-form-plan-and-product.jpg" alt="中文意向表中的套餐权限、产品介绍与提交入口" width="1280" height="720" loading="lazy" />

截图：[OpenAI 中文意向表](https://openai.com/zh-Hans-CN/form/sign-in-with-chatgpt-interest/)，2026-10-14，字段未填，未点击提交。

该日期的初次表单不要求 callback URL、client ID 或已经完成的 OAuth 服务器，可先如实填写项目计划。截图没有代替维护者提交申请；提交后仍需等待资格与权限确认。

## 4. 获得回复后确认条件

设计和部署前，向 OpenAI 确认：

- **应用与 client 类型**：浏览器扩展及托管后端是否获准，使用 public 还是 confidential client，以及分配的 client ID。
- **回调地址**：开发与生产的精确 callback URL，以及返回扩展的支持方式。流畅阅读尚无已批准的公共回调。
- **套餐使用**：批准是否包含套餐 AI 请求，以及 scopes、账户、模型和用量限制。
- **托管要求**：令牌交换、保护、续期与推理的许可和要求。

核对时，[网站指南](https://developers.openai.com/siwc/website) 只说明身份登录；[开源套餐注册指南](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 使用 `127.0.0.1` HTTP 回调，没有明确说明扩展的 `chrome.identity` 或 HTTPS 套餐回调。公共扩展的支持方式仍需官方确认。

计划中的后端会改变现有 [隐私政策](/guide/privacy) 所述的数据传递方式。获批后开发和上线前，需按实际方案披露凭证存储、内容转发、撤销与删除、数据保留。完成批准、部署和真实账户授权验证后，才能向普通用户开放。
