import assert from 'node:assert/strict';
import {
    extractJsonPath,
    deleteFromWebUploader,
    normalizeJsonObject,
    resolveImageUrl,
    uploadToWebUploader,
} from '../functions/utils/storage/webUploaderAPI.js';
import { getUploadConfig } from '../functions/api/manage/sysConfig/upload.js';

describe('Web Uploader adapter', () => {
    it('parses object configuration and dot-separated array paths', () => {
        assert.deepEqual(normalizeJsonObject('{"Authorization":"Bearer token"}', 'headers'), {
            Authorization: 'Bearer token',
        });
        assert.equal(extractJsonPath([{ src: '/images/a.png' }], '0.src'), '/images/a.png');
        assert.equal(extractJsonPath({ data: { url: 'https://img.example/a.png' } }, 'data.url'), 'https://img.example/a.png');
    });

    it('rejects invalid JSON object configuration', () => {
        assert.throws(() => normalizeJsonObject('["invalid"]', 'headers'), /JSON object/);
        assert.throws(() => normalizeJsonObject('{invalid', 'headers'), /valid JSON/);
    });

    it('joins an optional URL prefix with relative upstream paths', () => {
        assert.equal(
            resolveImageUrl('/files/a.png', 'https://api.example/upload', 'https://cdn.example/images'),
            'https://cdn.example/images/files/a.png',
        );
        assert.equal(
            resolveImageUrl('https://other.example/a.png', 'https://api.example/upload', 'https://cdn.example'),
            'https://other.example/a.png',
        );
    });

    it('uploads multipart data and extracts the configured response path', async () => {
        const file = new File(['image'], 'test.png', { type: 'image/png' });
        const channel = {
            url: 'https://api.example/upload',
            paramName: 'image',
            jsonPath: '0.src',
            deleteKeyJsonPath: '0.deleteKey',
            customHeader: { Authorization: 'Bearer token', 'Content-Type': 'invalid-boundary' },
            customBody: { album: 'screenshots', options: { private: false } },
            urlPrefix: 'https://cdn.example',
        };

        const result = await uploadToWebUploader(file, channel, async (url, init) => {
            assert.equal(url, 'https://api.example/upload');
            assert.equal(init.method, 'POST');
            assert.equal(init.headers.get('Authorization'), 'Bearer token');
            assert.equal(init.headers.has('Content-Type'), false);
            assert.equal(init.body.get('album'), 'screenshots');
            assert.equal(init.body.get('options'), '{"private":false}');
            assert.equal(init.body.get('image').name, 'test.png');

            return new Response(JSON.stringify([{ src: '/files/test.png', deleteKey: 'delete-123' }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        assert.deepEqual(result, {
            imageUrl: 'https://cdn.example/files/test.png',
            deleteKey: 'delete-123',
        });
    });

    it('calls an optional delete API with stored response data', async () => {
        const result = await deleteFromWebUploader({
            deleteUrl: 'https://s.ee/api/v1/file/delete/{deleteKey}',
            deleteMethod: 'GET',
            deleteHeaders: { Authorization: 'Bearer token' },
        }, 'delete key/1', 'https://s.ee/file/example.png', async (url, init) => {
            assert.equal(url, 'https://s.ee/api/v1/file/delete/delete%20key%2F1');
            assert.equal(init.method, 'GET');
            assert.equal(init.headers.get('Authorization'), 'Bearer token');
            return new Response(JSON.stringify({ code: 0 }), { status: 200 });
        });

        assert.deepEqual(result, { attempted: true, success: true });
    });

    it('does not call a delete API when the channel has none configured', async () => {
        const result = await deleteFromWebUploader({}, 'delete-123', 'https://img.example/file.png');
        assert.deepEqual(result, { attempted: false, success: false });
    });

    it('surfaces upstream errors without accepting their body as a URL', async () => {
        const file = new File(['image'], 'test.png', { type: 'image/png' });
        await assert.rejects(
            uploadToWebUploader(file, {
                url: 'https://api.example/upload',
                paramName: 'file',
            }, async () => new Response('invalid token', { status: 401 })),
            /upstream returned 401: invalid token/,
        );
    });

    it('loads persisted Web Uploader channels into upload settings', async () => {
        const db = {
            get: async () => JSON.stringify({
                webuploader: {
                    channels: [{
                        name: 'custom',
                        enabled: true,
                        customHeader: '{"X-Token":"secret"}',
                        customBody: '{"album":"default"}',
                    }],
                },
            }),
        };

        const settings = await getUploadConfig(db, {});
        assert.equal(settings.webuploader.channels[0].id, 1);
        assert.deepEqual(settings.webuploader.channels[0].customHeader, { 'X-Token': 'secret' });
        assert.deepEqual(settings.webuploader.channels[0].customBody, { album: 'default' });
        assert.equal(settings.webuploader.loadBalance.enabled, false);
    });
});
