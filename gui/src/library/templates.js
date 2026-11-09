/**
 * Document templates.
 *
 * A template is only a starting point: it supplies a title, a label, a kind
 * and the HTML the editor opens with. Everything else -- status, colour,
 * filename -- is the same as any other new document, so a reader can delete
 * or rename the scaffold without leaving a special case behind.
 *
 * The thesis template is deliberately structural rather than prose. It names
 * the sections an examiner expects and leaves a line under each one, which is
 * more useful than a paragraph of advice that has to be deleted before the
 * first sentence can be written.
 */

function page(title, subtitle, body) {
  return [
    `<h1>${title}</h1>`,
    `<p><em>${subtitle}</em></p>`,
    body,
  ].join('')
}

const thesis = {
  id: 'thesis',
  name: 'Thesis',
  eyebrow: 'Long-form research',
  description: 'Title page, abstract, chapters, methodology and references.',
  icon: 'published',
  title: 'Untitled thesis',
  kind: 'Thesis',
  collections: ['Thesis'],
  color: '#5b6c8a',
  content: page(
    'Thesis title',
    'Author · Institution · Year',
    [
      '<h2>Abstract</h2><p>Write the argument of the thesis in one paragraph: the question, the method, the finding and why it matters.</p>',
      '<h2>Acknowledgements</h2><p>Thank the people and institutions whose help made this work possible.</p>',
      '<h2>1. Introduction</h2><h3>1.1 Background</h3><p>Set the context and explain why the question is worth asking.</p><h3>1.2 Research question</h3><p>State the central question and the scope of the study.</p><h3>1.3 Structure of the thesis</h3><p>Signpost the chapters that follow.</p>',
      '<h2>2. Literature review</h2><h3>2.1 Key debates</h3><p>Map the conversation your work joins.</p><h3>2.2 Gap in the literature</h3><p>Identify what existing work has not yet answered.</p>',
      '<h2>3. Methodology</h2><h3>3.1 Research design</h3><p>Describe the approach and why it fits the question.</p><h3>3.2 Data collection</h3><p>Explain the sources, sample and instruments.</p><h3>3.3 Analysis</h3><p>Describe how the evidence will be read.</p><h3>3.4 Limitations</h3><p>Name the boundaries of the study honestly.</p>',
      '<h2>4. Results</h2><p>Present the findings without interpreting them yet.</p>',
      '<h2>5. Discussion</h2><p>Interpret the results against the literature and the research question.</p>',
      '<h2>6. Conclusion</h2><p>Return to the question, state the contribution and suggest what follows.</p>',
      '<h2>References</h2><ul><li>Add references in your department’s citation style.</li></ul>',
      '<h2>Appendices</h2><p>Supporting material that would interrupt the argument if placed in the body.</p>',
    ].join(''),
  ),
}

const essay = {
  id: 'essay',
  name: 'Essay',
  eyebrow: 'Argument and close reading',
  description: 'A thesis, three movements of argument and a conclusion.',
  icon: 'draft',
  title: 'Untitled essay',
  kind: 'Essay',
  collections: ['Essays'],
  color: '#8a5a2b',
  content: page(
    'Essay title',
    'Author · Course · Date',
    [
      '<h2>Introduction</h2><p>Open with the question, state the claim and signpost how the essay will argue it.</p>',
      '<h2>First movement</h2><p>Develop the first part of the argument and ground it in evidence.</p>',
      '<h2>Second movement</h2><p>Complicate the claim. Bring in the strongest counter-reading and answer it.</p>',
      '<h2>Third movement</h2><p>Show what follows once the objection has been met.</p>',
      '<h2>Conclusion</h2><p>Return to the opening claim and say what the reader should now see differently.</p>',
      '<h2>Works cited</h2><ul><li>Add sources in the required citation style.</li></ul>',
    ].join(''),
  ),
}

const report = {
  id: 'report',
  name: 'Report',
  eyebrow: 'Findings and recommendations',
  description: 'Summary, context, findings, recommendations and next steps.',
  icon: 'details',
  title: 'Untitled report',
  kind: 'Report',
  collections: ['Reports'],
  color: '#3d6f6a',
  content: page(
    'Report title',
    'Prepared by · For · Date',
    [
      '<h2>Executive summary</h2><p>Give the reader the finding and the recommendation in a short paragraph.</p>',
      '<h2>Background</h2><p>Explain why this report exists and what it covers.</p>',
      '<h2>Findings</h2><h3>Finding one</h3><p>State the evidence and what it shows.</p><h3>Finding two</h3><p>Add the second observation and its significance.</p>',
      '<h2>Recommendations</h2><ul><li>Recommendation one, with an owner and a date.</li><li>Recommendation two, with the cost and the expected result.</li></ul>',
      '<h2>Next steps</h2><p>Say who does what, and when the report should be reviewed.</p>',
      '<h2>Appendix</h2><p>Tables, method notes and raw material.</p>',
    ].join(''),
  ),
}


const cv = {
  id: 'cv',
  name: 'CV / résumé',
  eyebrow: 'Professional profile',
  description: 'Contact details, summary, experience, education and skills.',
  icon: 'users',
  title: 'Untitled CV',
  kind: 'CV',
  collections: ['CVs'],
  color: '#4f6b57',
  content: [
    '<h1>Full name</h1>',
    '<p><em>email@example.com · phone · city · website</em></p>',
    '<h2>Professional summary</h2><p>Two or three lines on the work you do, the value you bring and the role you are looking for.</p>',
    '<h2>Experience</h2>',
    '<h3>Job title — Company</h3><p><em>Start — Present · Location</em></p>',
    '<ul><li>Lead with the result, then the action that produced it.</li><li>Use numbers where they are honest: scope, time, revenue, users.</li></ul>',
    '<h3>Previous role — Company</h3><p><em>Dates · Location</em></p>',
    '<ul><li>One achievement the reader can verify or discuss.</li></ul>',
    '<h2>Education</h2><h3>Qualification — Institution</h3><p><em>Year</em></p>',
    '<h2>Skills</h2><p>Tools, methods and languages that matter for this role.</p>',
    '<h2>Selected projects</h2><p>Optional: two projects with a line on the problem and the outcome.</p>',
    '<h2>Certifications</h2><p>Optional: issuer and year.</p>',
  ].join(''),
}

const notes = {
  id: 'notes',
  name: 'Meeting notes',
  eyebrow: 'Fast capture',
  description: 'Attendees, agenda, decisions and action items.',
  icon: 'list',
  title: 'Untitled meeting notes',
  kind: 'Notes',
  collections: ['Notes'],
  color: '#7a5c9e',
  content: page(
    'Meeting notes',
    'Date · Time · Location',
    [
      '<h2>Attendees</h2><ul><li>Name — role</li></ul>',
      '<h2>Agenda</h2><ul><li>Item one</li><li>Item two</li></ul>',
      '<h2>Notes</h2><p>Capture decisions and the reasoning behind them, not a transcript.</p>',
      '<h2>Decisions</h2><ul><li>What was agreed.</li></ul>',
      '<h2>Action items</h2><ul><li>Owner — action — due date.</li></ul>',
    ].join(''),
  ),
}

const chapter = {
  id: 'chapter',
  name: 'Book chapter',
  eyebrow: 'Long-form manuscript',
  description: 'Chapter opening, scenes or sections, and a closing turn.',
  icon: 'file',
  title: 'Untitled chapter',
  kind: 'Chapter',
  collections: ['Chapters'],
  color: '#6a4a3a',
  content: page(
    'Chapter title',
    'Book title',
    [
      '<p>Open in a scene, a voice or a question. Give the reader a reason to turn the page.</p>',
      '<h2>Section one</h2><p>Develop the first movement of the chapter.</p>',
      '<h2>Section two</h2><p>Turn the argument or the story.</p>',
      '<h2>Section three</h2><p>Land the chapter somewhere the next one can begin.</p>',
    ].join(''),
  ),
}

const blank = {
  id: 'blank',
  name: 'Blank document',
  eyebrow: 'No scaffolding',
  description: 'An empty page with one heading, ready for anything.',
  icon: 'plus',
  title: 'Untitled document',
  kind: 'Draft',
  collections: ['Notes'],
  color: '#6a8792',
  content: '<h2>New section</h2><p><br></p>',
}

/** The templates, in the order the picker shows them. */
export const DOCUMENT_TEMPLATES = [blank, thesis, essay, report, cv, notes, chapter]

/** A template by id, falling back to the blank page. */
export function templateById(id) {
  return DOCUMENT_TEMPLATES.find((template) => template.id === id) || blank
}
