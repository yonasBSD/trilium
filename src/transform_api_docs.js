const sanitizeHtml = require('sanitize-html');

function transform(content) {
    const result = sanitizeHtml(content, {
        allowedTags: [
            'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
            'li', 'b', 'i', 'strong', 'em', 'strike', 's', 'del', 'abbr', 'code', 'hr', 'br', 'div',
            'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'section', 'img',
            'figure', 'figcaption', 'span', 'label', 'input',
        ],
        nonTextTags: [ 'style', 'script', 'textarea', 'option', 'h1', 'h2', 'h3', 'nav' ],
        allowedAttributes: {
            'a': [ 'href', 'class', 'data-note-path' ],
            'img': [ 'src' ],
            'section': [ 'class', 'data-note-id' ],
            'figure': [ 'class' ],
            'span': [ 'class', 'style' ],
            'label': [ 'class' ],
            'input': [ 'class', 'type', 'disabled' ],
            'code': [ 'class' ],
            'ul': [ 'class' ],
            'table': [ 'class' ],
            'en-media': [ 'hash' ]
        },
        allowedSchemes: ['http', 'https', 'ftp', 'mailto', 'data', 'evernote'],
        transformTags: {
           // 'h5': sanitizeHtml.simpleTransform('strong', {}, false),
            'table': sanitizeHtml.simpleTransform('table', {}, false)
        },
    });

    return result.replace(/<table>/gi, '<figure class="table"><table>')
        .replace(/<\/table>/gi, '</table></figure>')
        .replace(/<div><\/div>/gi, '')
        .replace(/<h5>/gi, '<p><strong>')
        .replace(/<\/h5>/gi, '</strong></p>')
        .replace(/<h4>/gi, '<h2>')
        .replace(/<\/h4>/gi, '</h2>')
        .replace(/<span class="signature-attributes">opt<\/span>/gi, '')
        .replace(/<h2>.*new (BackendScriptApi|FrontendScriptApi).*<\/h2>/gi, '')
        ;
}

const fs = require("fs");
const path = require("path");
const html = require("html");
let sourceFiles = [];

const getFilesRecursively = (directory) => {
    const filesInDirectory = fs.readdirSync(directory);
    for (const file of filesInDirectory) {
        const absolute = path.join(directory, file);
        if (fs.statSync(absolute).isDirectory()) {
            getFilesRecursively(absolute);
        } else if (file.endsWith('.html')) {
            sourceFiles.push(absolute);
        }
    }
};

getFilesRecursively('./tmp/api_docs');

for (const sourcePath of sourceFiles) {
    const content = fs.readFileSync(sourcePath).toString();
    const transformedContent = transform(content);
    const prettifiedContent = html.prettyPrint(transformedContent, {indent_size: 2});
    const filteredContent = prettifiedContent
        .replace(/<br \/>Documentation generated by <a href="https:\/\/github.com\/jsdoc\/jsdoc">[^<]+<\/a>/gi, '')
        .replace(/JSDoc: (Class|Module): [a-z]+/gi, '');

    const destPath = sourcePath.replaceAll("tmp", "docs");

    fs.mkdirSync(path.dirname(destPath), {recursive: true});
    fs.writeFileSync(destPath, filteredContent.trim());

    console.log(destPath);
}

const META_PATH = './docs/user_guide/!!!meta.json';
const meta = JSON.parse(fs.readFileSync(META_PATH).toString());

meta.files[0].children = meta.files[0].children.filter(note => note.title !== 'API docs');
meta.files[0].children.push(getApiMeta());

fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));

function getApiMeta() {
    return {
        "isClone": false,
        "noteId": "_apiDocs",
        "notePath": [
            "_userGuide",
            "_apiDocs"
        ],
        "title": "API docs",
        "notePosition": 10,
        "prefix": null,
        "isExpanded": false,
        "type": "text",
        "mime": "text/html",
        "attributes": [],
        "format": "html",
        "dataFileName": "API docs.html",
        "children": [
            {
                "isClone": false,
                "noteId": "_frontendApi",
                "notePath": [
                    "_userGuide",
                    "_frontendApi"
                ],
                "title": "API docs",
                "notePosition": 10,
                "prefix": null,
                "isExpanded": false,
                "type": "text",
                "mime": "text/html",
                "attributes": [],
                "format": "html",
                "dataFileName": "FrontendScriptApi.html"
            },
            {
                "isClone": false,
                "noteId": "_backendApi",
                "notePath": [
                    "_userGuide",
                    "_backendApi"
                ],
                "title": "API docs",
                "notePosition": 20,
                "prefix": null,
                "isExpanded": false,
                "type": "text",
                "mime": "text/html",
                "attributes": [],
                "format": "html",
                "dataFileName": "BackendScriptApi.html"
            }
        ]
    };
}