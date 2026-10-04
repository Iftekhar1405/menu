# KOT printing — approved sample output

Companion to `2026-10-04-kot-printing-design.md`. Laid out at the real column
widths the encoder targets: **32 columns on a 58mm roll, 48 on 80mm**. Lines
noted as *big* print double-width and double-height (`GS ! 0x11`); in
monospace below they look ordinary.

The scenario: table 7, order daily number 14. Biryani and friends at 8:42 PM,
then chai at 9:06 PM, closed at 9:31 PM.

## On accept — the counter's token slip (58mm)

Handed to the customer. No dishes, no prices.

```
        Taste of Hyderabad

              TOKEN
               14                  <- big
         
             Table 7
         04 Oct, 8:42 PM

================================
      Please keep this slip
```

## The same moment — the kitchen's ticket (80mm)

Same token number, so the slip in the customer's hand and the ticket on the
pass match. Item lines print double-height.

```
================================================
TOKEN 14                                 TABLE 7
8:42 PM                                  KOT #31
================================================

2 x Chicken Biryani
    (Full)
1 x Mutton Haleem
    >> less spicy
3 x Butter Naan
1 x Hyderabadi Double Ka Meetha

------------------------------------------------
Items                                          7
```

## Round 2, accepted at 9:06 PM — counter

```
        Taste of Hyderabad

              TOKEN
               14                  <- big
             Round 2
         
             Table 7
         04 Oct, 9:06 PM

================================
      Please keep this slip
```

## Round 2 — kitchen

**Only the new items.** Nothing from round 1 is reprinted, and round 1 is not
dragged backwards to produce this. `** RUNNING TABLE **` comes free from the
`isRunning` flag the order already carries.

```
================================================
TOKEN 14                                 TABLE 7
          *** ROUND 2 — NEW ITEMS ***
              ** RUNNING TABLE **
9:06 PM                                  KOT #38
================================================

2 x Irani Chai
1 x Osmania Biscuit

------------------------------------------------
Items                                          3
```

## On close — the counter's bill (80mm)

One order, one bill, covering every round. `Token 14` ties the paper back to
the slip the customer is holding.

```
                Taste of Hyderabad
     12-3-45 Banjara Hills, Hyderabad 500034
              GSTIN 36AABCT1234K1Z5

Bill #208                                Table 7
Token 14                         04 Oct, 9:31 PM
================================================
Chicken Biryani                           640.00
   2 x 320.00 · Full
Mutton Haleem                             280.00
   1 x 280.00
Butter Naan                               135.00
   3 x 45.00
Hyderabadi Double Ka Meetha               150.00
   1 x 150.00
Irani Chai                                 60.00
   2 x 30.00
Osmania Biscuit                            25.00
   1 x 25.00
------------------------------------------------
Subtotal                                 1223.81
GST 5% (incl.)                             61.19
================================================
TOTAL                                    1290.00
================================================

This is a receipt, not a GST tax invoice.

            Thank you — see you again!
```

Service charge is absent because it is off by default. When enabled it takes
its own line above the total, followed by the "voluntary, ask us to remove it"
sentence the screen and the PDF already carry.

## Merging across rounds

One Dum Biryani in round 1, two more in round 2. The bill merges them, because
the customer ordered three:

```
Dum Biryani                               960.00
   3 x 320.00
```

If the owner raised the price between the two rounds, the snapshots differ and
the lines stay apart — the bill never shows a price nobody was charged:

```
Dum Biryani                               320.00
   1 x 320.00
Dum Biryani                               660.00
   2 x 330.00
```

The **kitchen ticket never merges.** Round 2's ticket says `2 x Dum Biryani`,
because two is what the kitchen has to cook.
