#!/bin/bash
N=/tmp/y-axis/.scratch/notes/p-y-spread-2026-10-14
for spec in "P 0.95 p095" "P 0.9 p090" "P 0.85 p085" "P 0.6 p060" "Q 0.77 q077"; do
  set -- $spec
  bash $N/run-point.sh $1 $2 $3
done
echo SWEEP-DONE
