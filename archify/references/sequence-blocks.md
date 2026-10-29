# Sequence blocks and detail steps

Read this before writing a Sequence whose participants are classes or modules spread over more than one app,
service, firmware or hardware part, or whose flow has steps inside one part that the reader needs only on demand.
Example: `examples/commissioning-blocks.sequence.json`.

## Blocks (`groups`)

- Put the participants of one app, service, firmware or hardware part in one block:
  `{ "id", "label", "layer", "participants": [ids] }`.
- Give every app its own block, even when several apps sit on the same layer. Name the block after the app or part
  (`thread-service app`, `Debug app`, `C6 firmware`), short enough to fit above its columns.
- `layer` is one of `ui`, `app`, `service`, `firmware`, `hardware`, `external`. Order the participants so blocks run
  left to right as ui → app → service → firmware → hardware. Blocks on the same layer sit next to each other.
  `external` (a server, a mock, another company's part) has no fixed position.
- List the members of one block as adjacent participants, in call order inside the block.
- Each block gets a light tint by layer; the participant `type` still colors each participant box.

## Overview first, details on demand (`messages[].details`)

- Top-level messages are the overview: calls from one block to another. The label is the call (function, command
  or request name); the note says what the call is for.
- Steps that run inside one block right after a top-level step go into that step's `details`, in order:
  `{ "from", "to", "label", "note"?, "variant"? }`. Details need no `y`; the renderer lays them out.
- A detail step may call its own participant (`from` equals `to`), for example an internal `encodePublicKey`.
  Top-level messages still need two different participants.
- Steps are numbered automatically (1, 2, 3 and 2.1, 2.2 for details). Do not put numbers in labels.
- The viewer shows a round toggle on the called lifeline and on the step number. Opening it inserts the detail steps
  right below the step and moves the rest of the diagram down; closing it puts everything back.
- Keep a step's details to the work of that step. Move a call that crosses into another block to the overview when
  the reader needs it to follow the main flow.

## Layout notes

- A Sequence with blocks is laid out for reading at its actual size: the viewer keeps it 1:1 and scrolls sideways
  when it is wider than the window. Participants inside one block sit close together; the space between blocks is
  about twice as wide, so calls between blocks read as long trips. Do not set `meta.viewBox` for such a diagram.
- Message `y` values only set the order of the steps. The renderer spaces the steps by their notes and moves
  activation and segment edges with them, so keep `y` increasing in call order and do not tune spacing by hand.
- Keep labels short. A label wider than its lanes moves toward the side without an active bar, but a label between
  two active bars still touches them; put parameters in the note instead.
