I already told you that swap_tracker.cbor will eventually get removed, but the swap tracker we are using to track the swap state, right? We can just track it from the logs. We already have the logs, the log state of every single thing. Instead of relying on the swap tracker, I already told you to focus on logs, so we can properly switch to that right now. 

The historical things we can manage. No one is using it much, and this one is supposed to break a lot of things. That's all right. From now on, can we find the recoveries after the changes are in and we start swiping? From then on, we have a new version, and then all data should be preserved, right? It should not fail from now on. Same with the swap reports. We can ignore the previous ones because the previous ones are gone, and we cannot do anything about it. This was a breaking change, so from now on, everything can stay intact. From now on, we can point to the new location for the recovery and the swap report, so we can track properly. 

What do you mean, "once OpenSwap needs a few public reads"? What else do we need to cut if we don't have that? Also, there was a discussion of adding a single line in the maker config to point out which network it was on, like mainnet or singnet. Is that added? 

Okay, about the report files moving into the wallet, we created our own data structure because we needed that fo
r checker maker. I don't remember if the data structure we set up for portal was a bit different from the OpenSwap one. Did that get changed? 

Okay, I got board reading. Here are the notes. Look into it and tell me if there is anything that you need my decision for, or if you already have an understanding of what to do. 