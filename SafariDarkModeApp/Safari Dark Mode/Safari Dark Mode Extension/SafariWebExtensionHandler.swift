//
//  SafariWebExtensionHandler.swift
//  Safari Dark Mode Extension
//

import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        // No native messaging or telemetry. All processing stays inside the
        // webpage content script.
        context.completeRequest(returningItems: nil, completionHandler: nil)
    }

}
