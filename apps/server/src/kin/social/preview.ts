/**
 * The week's posts as one page a client can look at: Kin's own Typst template, never an agent's.
 * Captions and names are data in `inputs.json`, so nothing in them runs as Typst.
 */
const TEMPLATE = `#let data = json("/inputs.json")
#set page(paper: "a4", margin: 18mm)
#set text(size: 10pt)
#text(size: 16pt, weight: "bold")[#data.title]
#v(2pt)
#text(fill: luma(90))[For #data.client · to look over before it goes out]
#v(10pt)
#for post in data.posts [
  #block(breakable: false, stroke: 0.5pt + luma(200), radius: 6pt, inset: 10pt, width: 100%)[
    #grid(columns: (auto, 1fr), column-gutter: 12pt,
      if post.image != none { image("/recipe/files/" + post.image, width: 34mm) } else { box(width: 0pt) },
      [
        #text(weight: "bold")[#post.when]
        #h(6pt) #text(fill: luma(90))[#post.account]
        #v(4pt)
        #post.caption
      ],
    )
  ]
  #v(6pt)
]
`;

export const previewSheet = (input: {
  readonly title: string;
  readonly client: string;
  readonly posts: ReadonlyArray<{
    readonly when: string;
    readonly account: string;
    readonly caption: string;
    readonly image: string | null;
  }>;
  readonly files: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
  readonly day: string;
}) => ({
  template: TEMPLATE,
  data: { title: input.title, client: input.client, posts: input.posts },
  files: input.files,
  day: input.day,
});
