import { replaceImagePlaceholders, buildChapterInterleavedContent } from '../src/services/import/contentBuilder';

const mockImages = [
  { index: 2, position: 1, base64: 'data:image/jpeg;base64,123', alt: 'Test Image 2' },
  { index: 5, position: 2, base64: 'data:image/jpeg;base64,456', alt: 'Test Image 5' }
];

const mockData = {
  title: 'Test',
  paragraphs: [
    { index: 0, text: 'P1', tag: 'p' },
    { index: 1, text: 'P2', tag: 'p' },
    { index: 2, text: 'P3', tag: 'p' }
  ],
  images: mockImages,
  totalParagraphs: 3,
  totalImages: 2
};

console.log("=== Testing buildChapterInterleavedContent ===");
const interleaved = buildChapterInterleavedContent(mockData, [1, 3], [2, 5]);
console.log(interleaved);

console.log("\n=== Testing replaceImagePlaceholders ===");
const testContent1 = "<p>Text</p><p>{{IMG-2}}</p><p>Text</p>";
console.log("Input:", testContent1);
console.log("Output:", replaceImagePlaceholders(testContent1, mockImages));

const testContent2 = "<p>{{IMG-5}}</p>";
console.log("Input:", testContent2);
console.log("Output:", replaceImagePlaceholders(testContent2, mockImages));

const testContentFail = "<p>{{IMG-N}}</p>";
console.log("Input:", testContentFail);
console.log("Output:", replaceImagePlaceholders(testContentFail, mockImages));
