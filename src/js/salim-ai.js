// salim-ai.js — Internal AI Engine for Constructor by Salim Slimani.
//
// Provides direct client-side generation without relying on Puter.js cloud credits or balance.
// Supports Google Gemini, OpenAI, Groq, OpenRouter, and custom endpoints with streaming & function calling.

(function () {
    'use strict';

    const CONFIG_KEY = 'salim_ai_config';

    const DEFAULT_CONFIG = {
        provider: 'gemini', // 'gemini' | 'openai' | 'groq' | 'openrouter' | 'custom'
        apiKey: '',
        model: 'gemini-2.5-flash',
        endpoint: '',
        customHeaders: {}
    };

    function loadConfig() {
        try {
            const raw = localStorage.getItem(CONFIG_KEY);
            if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
        } catch (_) {}
        return { ...DEFAULT_CONFIG };
    }

    function saveConfig(cfg) {
        try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
        } catch (_) {}
    }

    let currentConfig = loadConfig();

    // -------------------------------------------------------------
    // Helper: Convert Constructor tools to Gemini function declarations
    // -------------------------------------------------------------
    function toGeminiTools(tools) {
        if (!Array.isArray(tools) || !tools.length) return undefined;
        const declarations = [];
        for (const t of tools) {
            const fn = t.function || t;
            if (!fn || !fn.name) continue;
            // Clean schema for Gemini: remove unsupported keys like additionalProperties
            const cleanSchema = (s) => {
                if (!s || typeof s !== 'object') return s;
                const copy = Array.isArray(s) ? [] : {};
                for (const k of Object.keys(s)) {
                    if (k === 'additionalProperties') continue;
                    copy[k] = typeof s[k] === 'object' && s[k] !== null ? cleanSchema(s[k]) : s[k];
                }
                return copy;
            };

            declarations.push({
                name: fn.name,
                description: fn.description || '',
                parameters: cleanSchema(fn.parameters) || { type: 'object', properties: {} }
            });
        }
        return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
    }

    // -------------------------------------------------------------
    // Helper: Convert messages to Gemini contents
    // -------------------------------------------------------------
    function toGeminiContents(messages) {
        let systemText = '';
        const contents = [];

        for (const m of messages) {
            if (m.role === 'system') {
                systemText += (systemText ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
                continue;
            }

            if (m.role === 'tool') {
                // Function response in Gemini
                contents.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: m.name || m.tool_call_id || 'tool',
                            response: { result: m.content }
                        }
                    }]
                });
                continue;
            }

            const role = m.role === 'assistant' ? 'model' : 'user';
            const parts = [];

            if (m.tool_calls && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    const fn = tc.function || tc;
                    let args = {};
                    try {
                        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {});
                    } catch (_) {}
                    parts.push({
                        functionCall: {
                            name: fn.name,
                            args: args
                        }
                    });
                }
            }

            if (typeof m.content === 'string' && m.content) {
                parts.unshift({ text: m.content });
            } else if (Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (typeof part === 'string') parts.push({ text: part });
                    else if (part && part.type === 'text') parts.push({ text: part.text });
                    else if (part && part.type === 'image_url') {
                        // inline data URL handling
                        const url = part.image_url?.url || '';
                        const match = url.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            parts.push({
                                inlineData: { mimeType: match[1], data: match[2] }
                            });
                        }
                    }
                }
            }

            if (parts.length > 0) {
                contents.push({ role, parts });
            }
        }

        return { systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined, contents };
    }

    // -------------------------------------------------------------
    // Gemini Stream Implementation
    // -------------------------------------------------------------
    async function* callGeminiStream(messages, options, cfg) {
        const apiKey = cfg.apiKey?.trim();
        if (!apiKey) {
            // Open settings dialog if no API key is provided
            window.SalimAI?.openSettingsModal?.();
            yield {
                type: 'text',
                text: '⚠️ **يرجى إدخال مفتاح الـ API الخاص بـ Salim Slimani AI للمتابعة.**\n\nتم فتح نافذة الإعدادات الآن. يمكنك استخدام مفتاح مجاني من [Google AI Studio](https://aistudio.google.com/app/apikey) أو إدخال مفتاح OpenAI/Groq الخاص بك.\n\nالذكاء الاصطناعي الآن يعمل داخلياً ومباشرة بدون الحاجة لحساب أو رصيد Puter!'
            };
            return;
        }

        const model = cfg.model || 'gemini-2.5-flash';
        const { systemInstruction, contents } = toGeminiContents(messages);
        const tools = toGeminiTools(options.tools);

        const body = {
            contents,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192
            }
        };
        if (systemInstruction) body.systemInstruction = systemInstruction;
        if (tools) body.tools = tools;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: options.signal
        });

        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            const errMsg = errJson?.error?.message || `Gemini API returned HTTP ${response.status}`;
            yield {
                type: 'error',
                message: `Salim Slimani AI Error: ${errMsg}`
            };
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === '[DONE]') break;

                try {
                    const data = JSON.parse(jsonStr);
                    const candidate = data.candidates?.[0];
                    if (!candidate) continue;

                    const parts = candidate.content?.parts || [];
                    for (const part of parts) {
                        if (part.text) {
                            yield { type: 'text', text: part.text };
                        }
                        if (part.functionCall) {
                            yield {
                                type: 'tool_use',
                                tool_call: {
                                    id: 'call_' + Math.random().toString(36).slice(2, 10),
                                    name: part.functionCall.name,
                                    arguments: part.functionCall.args || {}
                                }
                            };
                        }
                    }

                    if (data.usageMetadata) {
                        yield {
                            type: 'usage',
                            usage: {
                                usd_cents: 0,
                                input_tokens: data.usageMetadata.promptTokenCount || 0,
                                output_tokens: data.usageMetadata.candidatesTokenCount || 0
                            }
                        };
                    }
                } catch (_) {}
            }
        }
    }

    // -------------------------------------------------------------
    // OpenAI-Compatible Stream Implementation (OpenAI, Groq, OpenRouter, Custom)
    // -------------------------------------------------------------
    async function* callOpenAICompatibleStream(messages, options, cfg) {
        const apiKey = cfg.apiKey?.trim();
        let endpoint = cfg.endpoint?.trim();
        let defaultModel = 'gpt-4o';

        if (cfg.provider === 'groq') {
            endpoint = endpoint || 'https://api.groq.com/openai/v1/chat/completions';
            defaultModel = 'llama-3.3-70b-versatile';
        } else if (cfg.provider === 'openrouter') {
            endpoint = endpoint || 'https://openrouter.ai/api/v1/chat/completions';
            defaultModel = 'anthropic/claude-3.5-sonnet';
        } else if (cfg.provider === 'custom') {
            endpoint = endpoint || 'http://localhost:11434/v1/chat/completions';
        } else {
            endpoint = endpoint || 'https://api.openai.com/v1/chat/completions';
        }

        if (!apiKey && cfg.provider !== 'custom') {
            window.SalimAI?.openSettingsModal?.();
            yield {
                type: 'text',
                text: '⚠️ **يرجى إدخال مفتاح الـ API الخاص بـ Salim Slimani AI للمتابعة.**\n\nتم فتح نافذة الإعدادات الآن. يمكنك إدخال مفتاحك للبدء الفوري بدون الحاجة لرصيد Puter!'
            };
            return;
        }

        const model = cfg.model || defaultModel;

        // Clean tools for standard OpenAI format
        const cleanTools = (options.tools || []).map(t => {
            const fn = t.function || t;
            return {
                type: 'function',
                function: {
                    name: fn.name,
                    description: fn.description || '',
                    parameters: fn.parameters || { type: 'object', properties: {} }
                }
            };
        });

        const reqBody = {
            model,
            messages,
            stream: true
        };
        if (cleanTools.length) reqBody.tools = cleanTools;

        const headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            ...(cfg.customHeaders || {})
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(reqBody),
            signal: options.signal
        });

        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            const errMsg = errJson?.error?.message || `API error: HTTP ${response.status}`;
            yield { type: 'error', message: `Salim Slimani AI Error: ${errMsg}` };
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        const pendingToolCalls = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === '[DONE]') break;

                try {
                    const data = JSON.parse(jsonStr);
                    const delta = data.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.reasoning_content) {
                        yield { type: 'reasoning', reasoning: delta.reasoning_content };
                    }
                    if (delta.content) {
                        yield { type: 'text', text: delta.content };
                    }
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!pendingToolCalls[idx]) {
                                pendingToolCalls[idx] = {
                                    id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10),
                                    name: tc.function?.name || '',
                                    arguments: ''
                                };
                            }
                            if (tc.function?.name) pendingToolCalls[idx].name = tc.function.name;
                            if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments;
                        }
                    }

                    if (data.usage) {
                        yield {
                            type: 'usage',
                            usage: {
                                usd_cents: 0,
                                input_tokens: data.usage.prompt_tokens || 0,
                                output_tokens: data.usage.completion_tokens || 0
                            }
                        };
                    }
                } catch (_) {}
            }
        }

        // Emit any accumulated tool calls
        for (const idx of Object.keys(pendingToolCalls)) {
            const tc = pendingToolCalls[idx];
            let parsedArgs = {};
            try {
                parsedArgs = JSON.parse(tc.arguments);
            } catch (_) {
                parsedArgs = { raw: tc.arguments };
            }
            yield {
                type: 'tool_use',
                tool_call: {
                    id: tc.id,
                    name: tc.name,
                    arguments: parsedArgs
                }
            };
        }
    }

    // -------------------------------------------------------------
    // Main SalimAI.chat implementation
    // -------------------------------------------------------------
    async function chat(messages, options = {}) {
        const cfg = loadConfig();
        const isStream = options.stream !== false;

        let generator;
        if (cfg.provider === 'gemini') {
            generator = callGeminiStream(messages, options, cfg);
        } else {
            generator = callOpenAICompatibleStream(messages, options, cfg);
        }

        if (isStream) {
            return generator;
        }

        // Non-streaming mode (suggestions, project naming, etc.)
        let fullText = '';
        for await (const chunk of generator) {
            if (chunk.type === 'text') fullText += chunk.text;
        }
        return {
            message: { content: fullText },
            text: fullText
        };
    }

    // -------------------------------------------------------------
    // UI Modal: Salim Slimani AI Configuration
    // -------------------------------------------------------------
    function openSettingsModal() {
        const existing = document.getElementById('salim-ai-modal');
        if (existing) existing.remove();

        const cfg = loadConfig();

        const modalHtml = `
            <div id="salim-ai-modal" class="salim-modal-overlay">
                <div class="salim-modal-card">
                    <div class="salim-modal-header">
                        <div class="salim-modal-title-group">
                            <h2 class="salim-modal-title">✨ Salim Slimani AI Engine</h2>
                            <p class="salim-modal-subtitle">المحرك الداخلي لتوليد التطبيقات والمواقع — خاص بـ Salim Slimani وبدون قيود Puter</p>
                        </div>
                        <button class="salim-modal-close" id="salim-close-btn">&times;</button>
                    </div>

                    <div class="salim-modal-body">
                        <div class="salim-form-group">
                            <label class="salim-label" for="salim-provider-select">مزود الذكاء الاصطناعي (AI Provider):</label>
                            <select id="salim-provider-select" class="salim-select" aria-label="AI Provider">
                                <option value="gemini" ${cfg.provider === 'gemini' ? 'selected' : ''}>Google Gemini (موصى به - مجاني وسريع)</option>
                                <option value="openai" ${cfg.provider === 'openai' ? 'selected' : ''}>OpenAI (ChatGPT 4o / o1)</option>
                                <option value="groq" ${cfg.provider === 'groq' ? 'selected' : ''}>Groq (فائق السرعة)</option>
                                <option value="openrouter" ${cfg.provider === 'openrouter' ? 'selected' : ''}>OpenRouter (Claude / DeepSeek / Mistral)</option>
                                <option value="custom" ${cfg.provider === 'custom' ? 'selected' : ''}>Custom / Local Endpoint (Ollama / Proxy)</option>
                            </select>
                        </div>

                        <div class="salim-form-group">
                            <label class="salim-label" for="salim-api-key">مفتاح الـ API (API Key):</label>
                            <div class="salim-input-wrap">
                                <input type="password" id="salim-api-key" class="salim-input" aria-label="API Key" value="${cfg.apiKey || ''}" placeholder="أدخل مفتاح الـ API الخاص بك...">
                                <button type="button" class="salim-toggle-key" id="salim-toggle-key-btn" aria-label="Toggle password visibility">👁️</button>
                            </div>
                            <span class="salim-hint" id="salim-key-hint">
                                <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">👈 اضغط هنا للحصول على مفتاح Google Gemini مجاناً بنقرة واحدة</a>
                            </span>
                        </div>

                        <div class="salim-form-group">
                            <label class="salim-label" for="salim-model-input">النموذج (Model):</label>
                            <input type="text" id="salim-model-input" class="salim-input" aria-label="Model" value="${cfg.model || 'gemini-2.5-flash'}" placeholder="مثال: gemini-2.5-flash أو gpt-4o">
                        </div>

                        <div class="salim-form-group" id="salim-endpoint-group" style="${cfg.provider === 'custom' ? 'display:block;' : 'display:none;'}">
                            <label class="salim-label" for="salim-endpoint-input">رابط الـ Endpoint المخصص:</label>
                            <input type="text" id="salim-endpoint-input" class="salim-input" aria-label="Custom Endpoint" value="${cfg.endpoint || ''}" placeholder="http://localhost:11434/v1/chat/completions">
                        </div>
                    </div>

                    <div class="salim-modal-footer">
                        <button type="button" class="salim-btn salim-btn-secondary" id="salim-cancel-btn">إلغاء</button>
                        <button type="button" class="salim-btn salim-btn-primary" id="salim-save-btn">حفظ وتفعيل المحرك الداخلي</button>
                    </div>
                </div>
            </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.id = 'salim-ai-modal-styles';
        styleEl.textContent = `
            .salim-modal-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                backdrop-filter: blur(8px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 999999;
                font-family: inherit;
                direction: rtl;
            }
            .salim-modal-card {
                background: var(--bg-card, #1e1e24);
                color: var(--text-primary, #ffffff);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 16px;
                width: 90%;
                max-width: 520px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
                overflow: hidden;
                animation: salimPop 0.2s ease-out;
            }
            @keyframes salimPop {
                from { transform: scale(0.95); opacity: 0; }
                to { transform: scale(1); opacity: 1; }
            }
            .salim-modal-header {
                padding: 20px 24px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
            }
            .salim-modal-title {
                margin: 0;
                font-size: 1.25rem;
                font-weight: 700;
                color: #60a5fa;
            }
            .salim-modal-subtitle {
                margin: 6px 0 0 0;
                font-size: 0.85rem;
                color: rgba(255, 255, 255, 0.65);
            }
            .salim-modal-close {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.5);
                font-size: 1.5rem;
                cursor: pointer;
                line-height: 1;
            }
            .salim-modal-close:hover { color: #fff; }
            .salim-modal-body { padding: 20px 24px; }
            .salim-form-group { margin-bottom: 16px; }
            .salim-label { display: block; margin-bottom: 6px; font-size: 0.9rem; font-weight: 600; }
            .salim-select, .salim-input {
                width: 100%;
                padding: 10px 14px;
                border-radius: 8px;
                background: rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: #fff;
                font-size: 0.95rem;
                box-sizing: border-box;
            }
            .salim-select:focus, .salim-input:focus {
                outline: none;
                border-color: #3b82f6;
                box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
            }
            .salim-input-wrap { position: relative; }
            .salim-toggle-key {
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                background: none;
                border: none;
                cursor: pointer;
                font-size: 1rem;
            }
            .salim-hint { display: block; margin-top: 6px; font-size: 0.8rem; }
            .salim-hint a { color: #38bdf8; text-decoration: underline; }
            .salim-modal-footer {
                padding: 16px 24px;
                background: rgba(0, 0, 0, 0.2);
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                display: flex;
                justify-content: flex-end;
                gap: 12px;
            }
            .salim-btn {
                padding: 10px 18px;
                border-radius: 8px;
                font-size: 0.9rem;
                font-weight: 600;
                cursor: pointer;
                border: none;
                transition: 0.15s ease;
            }
            .salim-btn-secondary {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
            }
            .salim-btn-secondary:hover { background: rgba(255, 255, 255, 0.2); }
            .salim-btn-primary {
                background: #2563eb;
                color: #fff;
            }
            .salim-btn-primary:hover { background: #1d4ed8; }
        `;

        if (!document.getElementById('salim-ai-modal-styles')) {
            document.head.appendChild(styleEl);
        }

        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);

        const modal = document.getElementById('salim-ai-modal');
        const providerSel = document.getElementById('salim-provider-select');
        const keyInput = document.getElementById('salim-api-key');
        const modelInput = document.getElementById('salim-model-input');
        const endpointGroup = document.getElementById('salim-endpoint-group');
        const endpointInput = document.getElementById('salim-endpoint-input');
        const hintEl = document.getElementById('salim-key-hint');

        providerSel.addEventListener('change', () => {
            const p = providerSel.value;
            endpointGroup.style.display = p === 'custom' ? 'block' : 'none';
            if (p === 'gemini') {
                modelInput.value = 'gemini-2.5-flash';
                hintEl.innerHTML = '<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">👈 اضغط هنا للحصول على مفتاح Google Gemini مجاناً</a>';
            } else if (p === 'openai') {
                modelInput.value = 'gpt-4o';
                hintEl.innerHTML = '<a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">👈 احصل على مفتاح من OpenAI Platform</a>';
            } else if (p === 'groq') {
                modelInput.value = 'llama-3.3-70b-versatile';
                hintEl.innerHTML = '<a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">👈 احصل على مفتاح مجاني من Groq Console</a>';
            } else if (p === 'openrouter') {
                modelInput.value = 'anthropic/claude-3.5-sonnet';
                hintEl.innerHTML = '<a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">👈 احصل على مفتاح من OpenRouter</a>';
            } else {
                modelInput.value = 'llama3';
                hintEl.innerHTML = 'قم بتعيين عنوان الـ Endpoint ورقم المنفذ (مثل Ollama محلياً)';
            }
        });

        document.getElementById('salim-toggle-key-btn').addEventListener('click', () => {
            keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
        });

        const closeModal = () => modal.remove();
        document.getElementById('salim-close-btn').addEventListener('click', closeModal);
        document.getElementById('salim-cancel-btn').addEventListener('click', closeModal);

        document.getElementById('salim-save-btn').addEventListener('click', () => {
            const newCfg = {
                provider: providerSel.value,
                apiKey: keyInput.value.trim(),
                model: modelInput.value.trim(),
                endpoint: endpointInput.value.trim()
            };
            saveConfig(newCfg);
            currentConfig = newCfg;
            closeModal();
            if (window.showToast) {
                window.showToast('تم حفظ إعدادات Salim Slimani AI بنجاح!');
            }
        });
    }

    // Connect to puter.ai when puter is ready, replacing it with SalimAI
    function installAIGuard() {
        if (!window.puter) {
            window.puter = {};
        }
        window.puter.ai = {
            chat: chat
        };
    }

    installAIGuard();
    setInterval(installAIGuard, 500);

    window.SalimAI = {
        chat,
        loadConfig,
        saveConfig,
        openSettingsModal
    };
})();
