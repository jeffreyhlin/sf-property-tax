// The FAQ is also the site's answer-engine surface: scripts/gen-seo.mjs reads
// this file at build time and injects it into index.html as FAQPage JSON-LD,
// so search and answer engines see the same words readers do. Two rules follow
// from that. Questions are phrased the way people actually search, and every
// answer's first sentence answers the question on its own, because that first
// sentence is what gets quoted.
//
// npm run lint:copy checks this file against the house style rules.

export type FaqItem = { q: string; a: string };

export const FAQ: FaqItem[] = [
  {
    "q": "What does this map of San Francisco property taxes show?",
    "a": "It shows the gap between what each of San Francisco's roughly 207,000 properties is taxed on and what it would likely sell for today. Under California's Prop 13, a property's taxed value stays near its last sale price, so a home bought in 1985 can pay a tenth of the property tax its neighbor pays for a nearly identical house. The map estimates that gap for every parcel and translates it into dollars per year."
  },
  {
    "q": "Why is my neighbor's property tax so much lower than mine?",
    "a": "Almost always because they bought earlier. Prop 13 caps how fast a taxed value can grow at about 2% a year, and San Francisco prices have grown far faster than that for decades, so the tax bill mostly reflects when the property last changed hands rather than what it is worth. A long-held home can also pass to children, a spouse, or a trust without the value resetting, which carries the older, lower taxed value to the next owner."
  },
  {
    "q": "How much property tax revenue does Prop 13 shift in San Francisco?",
    "a": "About $2 billion a year, by this site's estimate. That is the difference between what San Francisco properties pay under their current assessments and what the same properties would pay if taxed on today's market value at the same rate. Roughly three quarters of that gap sits with owners who have simply held since before 2007."
  },
  {
    "q": "What does \"transferred without reassessment\" mean?",
    "a": "It means the tax roll shows the property changed hands, but its taxable value never reset to market, so the new owner inherited the old, lower value. Several things cause this. Some are family, spousal, or trust transfers, which California law exempts from reassessment. Others are ordinary sales where the price came in at or below the existing assessment, foreclosures, transfers between business entities, or affordable-housing partnerships whose assessments are restricted by regulation. The label states the pattern, not the reason. Open a parcel to see the actual recorded deeds and parties."
  },
  {
    "q": "How can you tell a sale from a family transfer without reading the deed?",
    "a": "From how the assessment behaves, and only partly. Prop 13 lets a taxed value grow about 2% a year until a sale resets it, so a new sale date plus a jump of more than 25% in taxed value means a market sale, while a new sale date with no jump means the transfer did not trigger a reassessment. The roll cannot say why the value held, so the site also pulls the recorded deeds from the county for the parcel you are looking at."
  },
  {
    "q": "Is the \"transferred without reassessment\" label a fact?",
    "a": "It is a fact about the assessment, not about the people. We checked: for the top parcels flagged this way, we pulled the real recorded deeds and found only about 11% were genuine family or trust transfers, while roughly 84% were arm's-length events such as foreclosures, developer sales, and affordable-housing partnership transfers. Our market estimate often runs above the actual sale price, so a real sale that reset to a lower real price can look like it never reset. That is why the label claims the pattern rather than a family transfer, and why each affected parcel carries a warning. The dollar figures are unaffected."
  },
  {
    "q": "How is the market value of each property estimated?",
    "a": "From recent sales of similar properties nearby. When a property is reassessed at sale, its new taxed value is roughly its sale price, so we take the median price per square foot of same-type properties in the same neighborhood that reset in the last 3 years and multiply by the building's square footage. Homes are compared to homes, apartment buildings to apartment buildings."
  },
  {
    "q": "How accurate are the market value estimates?",
    "a": "Off by about 18% at the median, validated against roughly 11,000 actual sales from 2022 to 2025. That makes each number a ballpark rather than an appraisal. The estimates are least reliable for unusual properties, large multi-unit buildings, and rent-controlled buildings."
  },
  {
    "q": "Where do the owner names come from?",
    "a": "From the San Francisco Assessor-Recorder's public index of recorded documents, which anyone can search by block and lot. When you open a parcel, this site queries that index and lists each recorded document with its date, type, and the grantor and grantee names exactly as the county recorded them. Every name shown is a public record, and each parcel links to the county index so you can verify it yourself."
  },
  {
    "q": "How do Prop 13, Prop 58, and Prop 19 work together?",
    "a": "Prop 13 (1978) taxes a property on what its owner paid for it, plus at most 2% growth a year, until it sells again. Prop 58 (1986) let parents pass that low taxed value to their children along with the property, and Prop 193 (1996) extended this to grandparents when the parents are deceased. Prop 19 (2021) narrowed the inheritance rules: the child now has to live in the home, and only about the first $1M of the discount carries over. Transfers before 2021 kept the older, more generous rules."
  },
  {
    "q": "Is it legal to publish property tax and deed records?",
    "a": "Yes. Assessment rolls and recorded deeds are public records under California law, and DataSF publishes the assessment datasets openly for anyone to use. This site adds analysis on top and publishes nothing the city and county have not already released: no phone numbers, no emails, no mailing addresses, and no linking of one owner across properties."
  },
  {
    "q": "Is it fair to single out individual properties?",
    "a": "People disagree, and that disagreement is part of why the site exists. One view holds that these are public records about a tax system that shifts billions between neighbors, and you cannot debate a policy you cannot see. Another holds that individual households did not design Prop 13 and should not be singled out for using it legally. We aim at the system rather than any one household, present the numbers neutrally, label inferences as inferences, and fix anything that turns out to be factually wrong."
  },
  {
    "q": "Something here looks wrong. Can you fix it?",
    "a": "Yes, and please say so. The things that go wrong here are a misparsed name, a parcel matched to the wrong records, a transfer we have mislabeled, or a market estimate that is off for an unusual property. Open an issue on the project's GitHub repository with the parcel and what looks wrong, and it will be corrected."
  },
  {
    "q": "Where does the data come from, and how often does it update?",
    "a": "Three public sources. DataSF's assessor secured tax rolls (2007 to present) and parcel map provide the numbers, and the Assessor-Recorder's public index of recorded documents provides the deed history and names. The assessor publishes a new roll once a year, and the site is rebuilt when it lands."
  }
];
