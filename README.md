# [mint](https://mint---box.vercel.app/)🙓
web app to track credit card statement activity

### purpose
Financial institutions do not expose APIs for users to access their own financial transaction data, however exportable .csv's are offered af the end of every statement. This application can make use of those exportable csv's (Date, Title, Amount), allow the user to 'tag' them, and output display the data through differnet 'perspectives' of your spending habits.

### personal aside on security in the future of apps
nowdays after the age of passwords, passkeys (device-identification-to-user specific authentication) is the go to. This transition implies the user is authenticated on the device they are using (hence they have access to the resource - which requests on behalf of the device). the entire purpose of authentication is for data CRUD to operate the application. If passkeys solely tie that to the user device itself, why not have the data (which the authentication is for) exist on the device as well? To give control/data back to the user - this application models using a 'save' file (folder) on the user's local computer - from which the frontend web app synchronizes and saves state with (in parallel with indexedDB for quicker cached respones). This way the user has control of the data - is taught how to use it, and the frontend web application simply pushes/pulls from it.

### stack
**ReactJS - IndexedDB - Vercel**

It was also a goal to have the stack for this project be entirely frontend, in your browser. The app's functionality is based on a very simple schema design, therefore the data can be held entirely locally, either via .csv files the user can export/move the 'state' of the app around, or the indexedDB keeping state persistent in browser.

### setup
To setup, just need to navigate to the public URL. You just need to keep providing the .csv's (w. 'Date', 'Amount' and 'Title' columns) representing your financial transactions.


### ex.
https://github.com/user-attachments/assets/31358819-f8aa-4dcf-950b-0d072ef7da5d


