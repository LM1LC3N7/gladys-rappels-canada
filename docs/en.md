# Recalls in Canada

Recalls and safety alerts published in Canada, read from the open data of
Health Canada: food recalls of the Canadian Food Inspection Agency (CFIA),
consumer products, vehicles, tires and child car seats of Transport Canada,
drugs and health products, medical devices. The integration gives Gladys a
device with two values, a scene trigger for each new recall of your
selection, a scene action and a dashboard widget.

It was tested against the real file of Health Canada and in a test Gladys
(29/10/2026), not yet over weeks of real use. No device of yours is involved:
the data comes from the cloud.

## What you get

- A device **Recalls in Canada** with:
  - **Recalls in 7 days**: the sheets of your selection, not archived, whose
    "last updated" day is one of the last 7 days (today included, in the time
    zone of Gladys). The file gives no publication date: an older sheet
    updated this week counts too.
  - **Latest recall**: the newest of them, with its day.
- A scene trigger **Canada: new recall in my selection**, with the title,
  product, category, issue, recall class, link and a one-sentence summary as
  variables. The trigger can be limited to some categories.
- A scene action **Canada: read the recalls of the last 7 days** (a sentence
  to send by message or read aloud, and the count).
- A widget **Recalls in Canada**: the latest recalls of your selection, the
  most serious ones (Class 1, Type I) in red, with the link to each sheet.
- A button **Show the recalls of the last 7 days** in the configuration.

## Configuration

1. **Categories**: food (CFIA), consumer products, vehicles (Transport
   Canada), drugs and health products, medical devices, other. Medical
   devices are not followed by default: a quarter of the sheets, nearly all
   hospital and laboratory equipment.
2. **Brands or words** (optional): only the recalls naming one of them in
   their title, product or category, separated by commas. Accents and case do
   not matter; a word matches whole words only ("nut" does not match
   "peanut").
3. **Check interval**: 3, 6 (default), 12 or 24 hours.
4. **Language of the recalls**: English or French. It picks the file read
   (each language has its own), the names of the features at their creation
   and the texts sent to the scenes.

Save, then create the device in the **Discover** tab.

## How it works

Health Canada publishes one file per language (16 MB in English, 21 MB in
French, about 34,000 sheets since 1991), regenerated once a day around 02:15
UTC. At each check the integration asks whether the file changed
(`If-None-Match` and `If-Modified-Since`): while it did not, the server
answers "not modified" and nothing is downloaded. When it changed, the file
is read as a stream: only the numbers (NID) of the sheets and the sheets of
the last 30 days stay in memory. One request at a time, with a User-Agent
naming the integration.

A recall is **new** when its number was absent from every file read before.
The first file ever read fires nothing (what is listed then is not news), nor
does a widened selection, nor a sheet only updated. A new sheet whose "last
updated" day is more than 7 days old is remembered without firing. A scene
event Gladys refuses is sent again at the next check; at most 20 events leave
per check, the rest at the next one.

What was seen, the copy of the recent sheets and the time of the last check
are kept in `/data`: a restart fires nothing again and keeps the time planned
for the next check. Changing the selection is applied at once from the copy
kept; changing the language reads the other file (not twice in 5 minutes).

## Status and failures

The status of the integration says:

- the file cannot be read (network, HTTP error), with the next try: 15
  minutes later, then 30, doubled up to the interval; a "429" or "5xx" answer
  starts a pause of 1 minute to 6 hours (the server's `Retry-After` when it
  gives one), kept across restarts;
- the file has not changed for more than 3 days (compared to the date the
  server gives): the counters are then not published again until it changes,
  so an old value is not shown as fresh;
- no category is selected;
- `/data` cannot be read or written.

Nothing is ever published as 0 when the file could not be read: the values
stay as they were.

## Limits

- A complement, not an official alert system: always check the recall sheet
  on [recalls-rappels.canada.ca](https://recalls-rappels.canada.ca/en). Not
  affiliated with the Government of Canada.
- The file holds no barcode (UPC) and no province: neither can be filtered.
- The file holds no publication date, only "last updated".

## Data and licence

Contains information licensed under the
[Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada)
(dataset [Recalls and Safety Alerts](https://open.canada.ca/data/en/dataset/d38de914-c94c-429b-8ab1-8776c31643e3),
Health Canada). No account, no key, no personal data.
