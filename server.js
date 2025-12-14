const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(__dirname)); // Serve static files like test.html

// Configuration for headers to send to upstream
const UPSTREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    // Add other headers here as needed, e.g., Referer
    // 'Referer': 'https://example.com/',
};

// Helper to resolve relative URLs
const resolveUrl = (base, relative) => {
    try {
        return new URL(relative, base).href;
    } catch (e) {
        return relative;
    }
};

app.get('/proxy', async (req, res) => {
    const { url, ...queryParams } = req.query;

    if (!url) {
        return res.status(400).send('Missing "url" query parameter');
    }

    // Extract custom headers from query params (prefixed with h_)
    const customHeaders = {};
    const headerParams = {};

    Object.keys(queryParams).forEach(key => {
        if (key.startsWith('h_')) {
            const headerName = key.substring(2); // remove 'h_'
            customHeaders[headerName] = queryParams[key];
            headerParams[key] = queryParams[key]; // keep for rewriting
        }
    });

    // Merge with default/hardcoded headers if any (custom headers take precedence)
    const headers = { ...UPSTREAM_HEADERS, ...customHeaders };

    const https = require('https');

    try {
        // Fetch the content
        const response = await axios.get(url, {
            headers: headers,
            responseType: 'arraybuffer', // Handle binary data (TS segments) correcty
            validateStatus: () => true, // Don't throw on error status
            httpsAgent: new https.Agent({ rejectUnauthorized: false }) // Bypass SSL errors
        });

        // Forward status code
        res.status(response.status);

        // Copy interesting headers
        const headersToCopy = ['content-type', 'content-length', 'last-modified', 'cache-control'];
        headersToCopy.forEach(h => {
            if (response.headers[h]) {
                res.setHeader(h, response.headers[h]);
            }
        });

        const contentType = response.headers['content-type'] || '';

        // If it's an m3u8 playlist, we need to rewrite it
        if (contentType.includes('application/vnd.apple.mpegurl') ||
            contentType.includes('application/x-mpegurl') ||
            url.endsWith('.m3u8')) {

            const originalBody = response.data.toString('utf8');
            const lines = originalBody.split('\n');

            // Reconstruct proxy base URL with existing header params
            const queryStr = new URLSearchParams(headerParams).toString();
            const proxyBase = req.protocol + '://' + req.get('host') + '/proxy?' + (queryStr ? queryStr + '&' : '') + 'url=';

            const rewrittenLines = lines.map(line => {
                const trimmed = line.trim();
                if (!trimmed) return line;
                if (trimmed.startsWith('#')) {
                    // Check for URI in tags like #EXT-X-KEY:METHOD=AES-128,URI="key.php"
                    if (trimmed.indexOf('URI="') !== -1) {
                        return trimmed.replace(/URI="(.*?)"/g, (match, p1) => {
                            const absoluteUrl = resolveUrl(url, p1);
                            return `URI="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
                        });
                    }
                    return line;
                }

                // It's a segment or playlist URL
                const absoluteUrl = resolveUrl(url, trimmed);
                return `${proxyBase}${encodeURIComponent(absoluteUrl)}`;
            });

            const rewrittenBody = rewrittenLines.join('\n');

            // Update content length since we changed the body
            res.setHeader('Content-Length', Buffer.byteLength(rewrittenBody));
            res.send(rewrittenBody);

        } else {
            // It's likely a segment (TS) or key or other asset. Pipe it through.
            res.send(response.data);
        }

    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).send('Proxy error: ' + error.message);
    }
});

app.get('/health', (req, res) => {
    res.send('OK');
});

app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
