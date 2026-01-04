const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(__dirname));

// --- OPTIMIZATION 1: Connection Pooling ---
// Create a shared instance with Keep-Alive enabled.
// This reuses TCP connections, eliminating SSL handshake overhead for segments.
const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    rejectUnauthorized: false // Bypass SSL errors
};

const axiosInstance = axios.create({
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent(agentOptions),
    // Disable default body size limits for large video segments
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true // Don't throw on 404/500
});

const UPSTREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124 Safari/537.36',
};

// Helper to resolve relative URLs
const resolveUrl = (base, relative) => {
    try {
        return new URL(relative, base).href;
    } catch (e) {
        return relative;
    }
};

app.get(['/proxy', '/stream.m3u8'], async (req, res) => {
    const { url, ...queryParams } = req.query;

    if (!url) {
        return res.status(400).send('Missing "url" query parameter');
    }

    // Header processing
    const customHeaders = {};
    const headerParams = {};
    
    // We can use a loop, but this is fast enough. 
    for (const [key, value] of Object.entries(queryParams)) {
        if (key.startsWith('h_')) {
            const headerName = key.substring(2);
            customHeaders[headerName] = value;
            headerParams[key] = value;
        }
    }

    const headers = { ...UPSTREAM_HEADERS, ...customHeaders };

    try {
        // --- OPTIMIZATION 2: Streaming Response ---
        // Use 'stream' instead of 'arraybuffer'. 
        // This pipes data directly to the user without filling up server RAM.
        const response = await axiosInstance.get(url, {
            headers: headers,
            responseType: 'stream' 
        });

        // Forward status
        res.status(response.status);

        // Forward headers (Filtered)
        const headersToCopy = ['content-type', 'content-length', 'last-modified', 'cache-control', 'expires'];
        headersToCopy.forEach(h => {
            if (response.headers[h]) {
                res.setHeader(h, response.headers[h]);
            }
        });

        const contentType = response.headers['content-type'] || '';
        
        // Check if it is an M3U8 Playlist
        // (We check extensions too because some servers return wrong content-types)
        const isM3U8 = contentType.includes('mpegurl') || url.split('?')[0].endsWith('.m3u8');

        if (isM3U8) {
            // M3U8 Logic: We MUST buffer this to rewrite it.
            // Since M3U8 files are text and small (KB), this is fine.
            let manifestData = '';
            
            response.data.on('data', chunk => manifestData += chunk);
            
            response.data.on('end', () => {
                const lines = manifestData.toString().split('\n');
                
                // Reconstruct proxy base URL
                const queryStr = new URLSearchParams(headerParams).toString();
                const proxyBase = `${req.protocol}://${req.get('host')}${req.path}?${queryStr ? queryStr + '&' : ''}url=`;

                const rewrittenBody = lines.map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) {
                        // Handle Key URI inside tags
                        if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI="')) {
                            return trimmed.replace(/URI="(.*?)"/, (match, p1) => {
                                const abs = resolveUrl(url, p1);
                                return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
                            });
                        }
                        return line;
                    }

                    // It's a segment URL
                    const absoluteUrl = resolveUrl(url, trimmed);
                    return `${proxyBase}${encodeURIComponent(absoluteUrl)}`;
                }).join('\n');

                // Update headers for the modified content
                res.removeHeader('content-length'); // Remove original length
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.send(rewrittenBody);
            });

        } else {
            // --- OPTIMIZATION 3: Pipe Segments ---
            // If it's a TS segment, pipe it directly. 
            // Zero memory overhead, minimal latency.
            response.data.pipe(res);
            
            // Handle errors during the stream
            response.data.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) res.status(500).end();
            });
        }

    } catch (error) {
        console.error('Proxy error:', error.message);
        if (!res.headersSent) {
            res.status(500).send('Proxy error: ' + error.message);
        }
    }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`Optimized Proxy server running on port ${PORT}`);
});
