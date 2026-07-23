const BLOCKED_MULTIPART_HEADERS = new Set([
    'content-length',
    'content-type',
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
    if (channel?.jsonPath) {
        let responseBody;
        try {
            responseBody = JSON.parse(responseText);
        } catch {
            throw new Error('upstream response is not valid JSON');
        }
        imageUrl = extractJsonPath(responseBody, channel.jsonPath);
    }

    return resolveImageUrl(imageUrl, apiUrl, channel?.urlPrefix || '');
}

function serializeFormValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
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
