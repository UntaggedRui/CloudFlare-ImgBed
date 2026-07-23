const BLOCKED_MULTIPART_HEADERS = new Set([
    'content-length',
    'content-type',
    'host',
]);

const BLOCKED_DELETE_HEADERS = new Set([
    'content-length',
    'host',
]);

export function normalizeJsonObject(value, fieldName) {
    if (value === undefined || value === null || value === '') {
        return {};
    }

    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            throw new Error(`${fieldName} must be valid JSON`);
        }
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        throw new Error(`${fieldName} must be a JSON object`);
    }

    return parsed;
}

export function extractJsonPath(value, jsonPath) {
    if (!jsonPath) return value;

    return jsonPath.split('.').reduce((current, segment) => {
        if (current === undefined || current === null || segment === '') {
            return undefined;
        }
        return current[segment];
    }, value);
}

export function resolveImageUrl(value, apiUrl, urlPrefix = '') {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('response does not contain an image URL');
    }

    const imageUrl = value.trim();
    let resolved;

    if (urlPrefix && !isAbsoluteUrl(imageUrl)) {
        resolved = `${urlPrefix.replace(/\/+$/, '')}/${imageUrl.replace(/^\/+/, '')}`;
    } else {
        resolved = new URL(imageUrl, apiUrl).toString();
    }

    assertHttpUrl(resolved, 'image URL');
    return resolved;
}

export async function uploadToWebUploader(file, channel, fetchImpl = fetch) {
    if (!file) {
        throw new Error('no file provided');
    }

    const apiUrl = assertHttpUrl(channel?.url, 'API URL');
    const paramName = String(channel?.paramName || '').trim();
    if (!paramName) {
        throw new Error('POST parameter name is required');
    }

    const customHeaders = normalizeJsonObject(channel?.customHeader, 'Custom headers');
    const customBody = normalizeJsonObject(channel?.customBody, 'Custom body');
    const headers = new Headers();

    for (const [name, value] of Object.entries(customHeaders)) {
        if (!BLOCKED_MULTIPART_HEADERS.has(name.toLowerCase())) {
            headers.set(name, String(value));
        }
    }

    const formData = new FormData();
    for (const [name, value] of Object.entries(customBody)) {
        formData.append(name, serializeFormValue(value));
    }
    formData.set(paramName, file, file.name || 'upload');

    const response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers,
        body: formData,
    });

    const responseText = await response.text();
    if (!response.ok) {
        const detail = responseText.slice(0, 500).trim();
        throw new Error(`upstream returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    let imageUrl = responseText;
    let responseBody;
    if (channel?.jsonPath) {
        try {
            responseBody = JSON.parse(responseText);
        } catch {
            throw new Error('upstream response is not valid JSON');
        }
        imageUrl = extractJsonPath(responseBody, channel.jsonPath);
    }

    return {
        imageUrl: resolveImageUrl(imageUrl, apiUrl, channel?.urlPrefix || ''),
        deleteKey: channel?.deleteKeyJsonPath
            ? extractJsonPath(responseBody ?? tryParseJson(responseText), channel.deleteKeyJsonPath)
            : undefined,
    };
}

export async function deleteFromWebUploader(channel, deleteKey, fileUrl, fetchImpl = fetch) {
    const deleteUrlTemplate = String(channel?.deleteUrl || '').trim();
    if (!deleteUrlTemplate) {
        return { attempted: false, success: false };
    }

    if (deleteUrlTemplate.includes('{deleteKey}') && !deleteKey) {
        throw new Error('delete API requires a delete key, but none was stored for this file');
    }

    const method = String(channel?.deleteMethod || 'GET').trim().toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error('delete method must be GET, POST, PUT, PATCH, or DELETE');
    }

    const values = {
        deleteKey: deleteKey || '',
        fileUrl: fileUrl || '',
    };
    const apiUrl = assertHttpUrl(replaceTemplateValues(deleteUrlTemplate, values, true), 'Delete API URL');
    const customHeaders = normalizeJsonObject(channel?.deleteHeaders, 'Delete headers');
    const customBody = normalizeJsonObject(channel?.deleteBody, 'Delete body');
    const headers = new Headers();

    for (const [name, value] of Object.entries(customHeaders)) {
        if (!BLOCKED_DELETE_HEADERS.has(name.toLowerCase())) {
            headers.set(name, replaceTemplateValues(String(value), values));
        }
    }

    const request = { method, headers };
    if (Object.keys(customBody).length > 0) {
        if (method === 'GET') {
            throw new Error('GET delete requests cannot include a custom body');
        }
        if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        request.body = JSON.stringify(replaceTemplateValues(customBody, values));
    }

    const response = await fetchImpl(apiUrl, request);
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 500).trim();
        throw new Error(`delete API returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    return { attempted: true, success: true };
}

function serializeFormValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function tryParseJson(value) {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function replaceTemplateValues(value, values, encode = false) {
    if (typeof value === 'string') {
        return value.replace(/\{(deleteKey|fileUrl)\}/g, (_, key) => encode ? encodeURIComponent(values[key]) : values[key]);
    }
    if (Array.isArray(value)) {
        return value.map((item) => replaceTemplateValues(item, values, encode));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTemplateValues(item, values, encode)]));
    }
    return value;
}

function isAbsoluteUrl(value) {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value) || value.startsWith('//');
}

function assertHttpUrl(value, fieldName) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch {
        throw new Error(`${fieldName} must be a valid URL`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${fieldName} must use HTTP or HTTPS`);
    }

    return url.toString();
}
