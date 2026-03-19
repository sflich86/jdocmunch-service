const DEFAULT_DOC_INDEX_PATH = "/root/.local/share/jdocmunch/doc-index";

function getDocIndexPath(env) {
    var source = env || process.env;
    return source.DOC_INDEX_PATH || DEFAULT_DOC_INDEX_PATH;
}

function getIndexedFilename(filename, fallbackBookId) {
    var safeFilename = String(filename || fallbackBookId || "book");
    if (!safeFilename.toLowerCase().endsWith(".md") && !safeFilename.toLowerCase().endsWith(".txt")) {
        safeFilename += ".md";
    }
    return safeFilename;
}

function formatSearchResponse(query, chunks) {
    var list = Array.isArray(chunks) ? chunks : [];
    return {
        success: true,
        query: query,
        total_chunks: list.length,
        candidates: list.map(function(c) {
            return {
                id: c.id,
                text: c.content,
                breadcrumb: c.source_file,
                score: c.score
            };
        }),
        results: list.map(function(c) {
            return {
                id: c.id,
                title: c.source_file || "libro",
                summary: c.content,
                content: c.content,
                score: c.score
            };
        })
    };
}

module.exports = {
    DEFAULT_DOC_INDEX_PATH,
    getDocIndexPath,
    getIndexedFilename,
    formatSearchResponse
};
