import { app } from "@azure/functions";

const header = `
            <?xml version='1.0' encoding='UTF-8'?>
            <!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.0 Transitional//EN' 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd'>
            <html xmlns='http://www.w3.org/1999/xhtml' xml:lang='en' lang='en'>
            <head>
                <title></title>
                <meta http-equiv='Content-Type' content='text/html;charset=utf-8' />
                <meta name='ocr-system' content='Microsoft Cognitive Services' />
                <meta name='ocr-capabilities' content='ocr_page ocr_carea ocr_par ocr_line ocrx_word'/>
            </head>
            <body>`;
const footer = '</body></html>';

class Point {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
}

class HocrPage {
    constructor(imageMetadata, pageNumber, wordAnnotations = null) {
        this.metadata = [];
        this.text = [];

        // page
        this.metadata.push(`<div class='ocr_page' id='page_${pageNumber}' title='image "${imageMetadata.imageStoreUri}"; bbox 0 0 ${imageMetadata.width} ${imageMetadata.height}; ppageno ${pageNumber}'>`);
        this.metadata.push(`<div class='ocr_carea' id='block_${pageNumber}_1'>`);

        let wordGroups = this.buildOrderedWordGroupsFromBoundingBoxes(imageMetadata);

        let line = 0;
        let wordIndex = 0;
        for (const words of wordGroups) {
            this.metadata.push(`<span class='ocr_line' id='line_${pageNumber}_${line}' title='baseline -0.002 -5; x_size 30; x_descenders 6; x_ascenders 6'>`);

            for (const word of words) {
                let annotation = '';
                if (wordAnnotations && wordAnnotations[word.text]) {
                    annotation = `data-annotation='${wordAnnotations[word.text]}'`;
                }
                const bbox = word.boundingBox && word.boundingBox.length === 4 ? `bbox ${word.boundingBox[0].x} ${word.boundingBox[0].y} ${word.boundingBox[2].x} ${word.boundingBox[2].y}` : '';
                this.metadata.push(`<span class='ocrx_word' id='word_${pageNumber}_${line}_${wordIndex}' title='${bbox}' ${annotation}>${word.text}</span>`);
                this.text.push(word.text);
                wordIndex++;
            }
            line++;
            this.metadata.push('</span>'); // Line
        }
        this.metadata.push('</div>'); // Reading area
        this.metadata.push('</div>'); // Page
    }

    getMetadata() {
        return this.metadata.join('\r\n');
    }

    getText() {
        return this.text.join(' ');
    }

    buildOrderedWordGroupsFromBoundingBoxes(imageMetadata) {
        const lines = imageMetadata.handwrittenLayoutText && imageMetadata.layoutText
            ? (imageMetadata.handwrittenLayoutText.lines.length > imageMetadata.layoutText.lines.length
                ? imageMetadata.handwrittenLayoutText.lines
                : imageMetadata.layoutText.lines)
            : (imageMetadata.handwrittenLayoutText
                ? imageMetadata.handwrittenLayoutText.lines
                : imageMetadata.layoutText.lines);

        const words = imageMetadata.handwrittenLayoutText && imageMetadata.layoutText
            ? (imageMetadata.handwrittenLayoutText.words.length > imageMetadata.layoutText.words.length
                ? imageMetadata.handwrittenLayoutText.words
                : imageMetadata.layoutText.words)
            : (imageMetadata.handwrittenLayoutText
                ? imageMetadata.handwrittenLayoutText.words
                : imageMetadata.layoutText.words);

        const lineGroups = [];
        for (const line of lines) {
            const currGroup = { line: line, words: [] };
            for (const word of words) {
                if (this.checkIntersection(line.boundingBox, word.boundingBox) && line.text.includes(word.text)) {
                    currGroup.words.push(word);
                }
            }
            lineGroups.push(currGroup);
        }
        return lineGroups
            .sort((a, b) => Math.max(...a.line.boundingBox.map(p => p.y)) - Math.max(...b.line.boundingBox.map(p => p.y)))
            .map(grp => grp.words.length > 0 && grp.words[0].boundingBox === null
                ? grp.words
                : grp.words.sort((a, b) => a.boundingBox[0].x - b.boundingBox[0].x));
    }

    checkIntersection(line, word) {
        const lineLeft = Math.min(...line.map(pt => pt.x));
        const lineTop = Math.min(...line.map(pt => pt.y));
        const lineRight = Math.max(...line.map(pt => pt.x));
        const lineBottom = Math.max(...line.map(pt => pt.y));

        const wordLeft = Math.min(...word.map(pt => pt.x));
        const wordTop = Math.min(...word.map(pt => pt.y));
        const wordRight = Math.max(...word.map(pt => pt.x));
        const wordBottom = Math.max(...word.map(pt => pt.y));

        return !(wordLeft > lineRight
            || wordRight < lineLeft
            || wordTop > lineBottom
            || wordBottom < lineTop);
    }
}

class HocrDocument {
    constructor(pages) {
        this.metadata = [header, ...pages.map(p => p.getMetadata()), footer].join('\r\n');
        this.text = pages.map(p => p.getText()).join('\r\n');
    }
}

async function hocrGenerator(req, context) {
    context.log('hOCR Generator Custom Skill: JavaScript HTTP trigger function processed a request.');

    const skillName = context.executionContext.functionName;
    const requestRecords = req.body && req.body.values;

    if (!requestRecords || requestRecords.length !== 1) {
        return {
            status: 400,
            body: `${skillName} - Invalid request record array: Skill requires exactly 1 image per request.`
        };
    }

    const imageMetadataList = requestRecords[0].data.ocrImageMetadataList;
    const wordAnnotations = {};
    if (requestRecords[0].data.wordAnnotations) {
        for (const annotation of requestRecords[0].data.wordAnnotations) {
            wordAnnotations[annotation.value] = annotation.description;
        }
    }

    const pages = imageMetadataList.map((imageMetadata, i) => new HocrPage(imageMetadata, i, wordAnnotations));
    const hocrDocument = new HocrDocument(pages);

    return {
        body: {
            values: [
                {
                    recordId: requestRecords[0].recordId,
                    data: {
                        hocrDocument: {
                            metadata: hocrDocument.metadata,
                            text: hocrDocument.text
                        }
                    },
                    errors: [],
                    warnings: []
                }
            ]
        }
    };
};

app.http('hocr-generator', {
    route: "hocr-generator",
    methods: ['POST'],
    authLevel: 'function',
    handler: hocrGenerator
});
