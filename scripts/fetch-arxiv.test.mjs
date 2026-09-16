import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCatchupHtml,
  parseCatchupPapers,
  extractFigures,
  extractFirstFigure
} from './fetch-arxiv.mjs';

const catchupHtml = `
  <h3>New submissions for Monday, 14 September 2026</h3>
  <dl>
    <dt><a href = '/abs/2609.01234v2'>arXiv:2609.01234</a>
        <a href = "https://arxiv.org/html/2609.01234v2">html</a></dt>
    <dd>
      <div class='list-title mathjax'>Title: A Cosmic Test</div>
      <div class="list-authors">Authors: <a>Ada Lovelace</a>, <a>Subrahmanyan Chandrasekhar</a></div>
      <div class="list-subjects">Subjects: Astrophysics of Galaxies (astro-ph.GA); Cosmology (astro-ph.CO)</div>
      <p class='mathjax'>We test &amp; measure the cosmos.</p>
    </dd>
  </dl>
  <h3>Cross submissions</h3>
  <dl><dt><a href="/abs/2609.09999">arXiv:2609.09999</a></dt><dd>Other</dd></dl>
  <h3>Replacement submissions</h3>
  <dl><dt><a href='/abs/2609.07777v3'>arXiv:2609.07777</a></dt><dd>Other</dd></dl>
  Total of 3 entries
`;

test('catchup headings tolerate whitespace, quotes, and version suffixes', () => {
  assert.deepEqual(parseCatchupHtml(catchupHtml), {
    new: ['2609.01234'],
    cross: ['2609.09999'],
    repl: ['2609.07777']
  });
});

test('catchup metadata parser extracts core paper fields', () => {
  const paper = parseCatchupPapers(catchupHtml, '2026-09-14').get('2609.01234');
  assert.equal(paper.title, 'A Cosmic Test');
  assert.deepEqual(paper.authors, ['Ada Lovelace', 'Subrahmanyan Chandrasekhar']);
  assert.deepEqual(paper.categories, ['astro-ph.GA', 'astro-ph.CO']);
  assert.equal(paper.summary, 'We test & measure the cosmos.');
  assert.equal(paper.htmlUrl, 'https://arxiv.org/html/2609.01234v2');
});

test('figure parser extracts several unique arXiv figures and captions', () => {
  const html = `
    <figure><img class="ltx_graphics" src="x1.png"><figcaption>Figure 1: First result</figcaption></figure>
    <figure><img class='plot ltx_graphics' src='/html/2609.01234/x2.png'><figcaption>Figure 2. Second result</figcaption></figure>
    <figure><img class="ltx_graphics" src="x3.png"><figcaption>Figure 3: Radius <math alttext="R_\\star"><mi>R</mi></math>.</figcaption></figure>
    <figure><img class="ltx_graphics" src="https://example.com/no.png"></figure>
  `;
  const figures = extractFigures(html, 'https://arxiv.org/html/2609.01234/');
  assert.deepEqual(figures, [
    { url: 'https://arxiv.org/html/2609.01234/x1.png', caption: 'First result' },
    { url: 'https://arxiv.org/html/2609.01234/x2.png', caption: 'Second result' },
    {
      url: 'https://arxiv.org/html/2609.01234/x3.png',
      caption: 'Radius R .',
      captionLatex: 'Radius $R_\\star$ .'
    }
  ]);
  assert.equal(extractFirstFigure(html, 'https://arxiv.org/html/2609.01234/').thumbnailUrl, figures[0].url);
});
